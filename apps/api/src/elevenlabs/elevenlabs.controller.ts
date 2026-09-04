import { Body, Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/public.decorator';
import { WebhookLogService } from '../shared/webhook-log.service';
import { ElevenLabsVozService } from './elevenlabs-voz.service';

/**
 * Lo que la consola y ElevenLabs necesitan del canal de voz: disparar una
 * llamada, y recibir la transcripción cuando termina.
 */
@Controller()
export class ElevenLabsController {
  private readonly logger = new Logger(ElevenLabsController.name);
  private readonly secreto: string;

  constructor(
    private readonly voz: ElevenLabsVozService,
    private readonly webhookLog: WebhookLogService,
    config: ConfigService,
  ) {
    this.secreto = config.get<string>('ELEVENLABS_WEBHOOK_SECRET', '');
  }

  /** Los números disponibles: sirve para saber qué poner en la config. */
  @Post('api/voz/numeros')
  async numeros() {
    if (!this.voz.puedeLlamar() && this.voz.faltantes().includes('ELEVENLABS_API_KEY')) {
      return { numeros: [], faltantes: this.voz.faltantes() };
    }
    return { numeros: await this.voz.numeros().catch(() => []), faltantes: this.voz.faltantes() };
  }

  /** Llama al contacto con el agente de voz. Lo dispara la consola. */
  @Post('api/contacts/:id/llamar')
  async llamar(@Param('id') id: string, @Req() req: FastifyRequest & { user?: { username?: string } }) {
    const quien = req.user?.username ?? 'un operador';
    return this.voz.llamar(id, quien);
  }

  /** Reintento manual, por si el webhook de cierre no llegó. */
  @Post('api/voz/transcripcion/:conversationId')
  traer(@Param('conversationId') conversationId: string) {
    return this.voz.traerTranscripcion(conversationId);
  }

  /**
   * Reingesta las últimas llamadas del agente.
   *
   * Para llenar huecos: llamadas que ocurrieron mientras el webhook fallaba, o
   * las que se descartaban por no salir de nuestro botón. Es idempotente, así
   * que apretarlo de más no duplica nada.
   */
  @Post('api/voz/reprocesar')
  reprocesar() {
    return this.voz.reprocesar();
  }

  /**
   * Webhook de post-llamada de ElevenLabs.
   *
   * Trae la transcripción al terminar. Se responde 200 siempre para que no
   * reintente en bucle, y el trabajo se ESPERA antes de contestar: en
   * serverless la instancia se congela al responder, así que dispararlo sin
   * esperar sería perderlo — la misma lección que nos costó rondas con el
   * rescate de NL Pearl.
   */
  @Public()
  @Post('webhooks/elevenlabs')
  @HttpCode(200)
  async cierre(@Body() body: unknown, @Req() req: FastifyRequest) {
    const payload = (body ?? {}) as {
      type?: string;
      data?: { conversation_id?: string; agent_id?: string };
      conversation_id?: string;
    };

    if (!this.autorizado(req)) {
      this.webhookLog.push('nlpearl', 'Webhook de ElevenLabs con secreto inválido: rechazado', false);
      return { received: false };
    }

    const conversationId = payload.data?.conversation_id ?? payload.conversation_id;
    if (!conversationId) {
      this.webhookLog.push('nlpearl', `Webhook de ElevenLabs sin conversation_id (${payload.type ?? 'sin tipo'})`, false);
      return { received: true };
    }

    const { nuevos, aviso } = await this.voz.traerTranscripcion(conversationId);
    this.webhookLog.push(
      'nlpearl',
      aviso
        ? `Llamada terminada pero la transcripción no entró: ${aviso}`
        : `Llamada terminada: ${nuevos} turno(s) al hilo`,
      !aviso,
    );
    await this.webhookLog.flush();
    return { received: true, nuevos };
  }

  /**
   * Fail-open, igual que los demás webhooks: sin secreto configurado no se
   * exige, y se empieza a exigir recién cuando se pone en los dos lados.
   */
  private autorizado(req: FastifyRequest): boolean {
    if (!this.secreto) return true;
    const headers = req.headers as Record<string, string | undefined>;
    const recibido = headers['x-webhook-secret'] ?? headers['elevenlabs-signature'] ?? '';
    const a = Buffer.from(recibido, 'utf-8');
    const b = Buffer.from(this.secreto, 'utf-8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
