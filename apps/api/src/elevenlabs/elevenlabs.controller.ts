import { Body, Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
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

    const auth = this.autorizado(req);
    if (!auth.ok) {
      // Con el motivo, no un "inválido" a secas: la diferencia entre "no llegó
      // la cabecera" y "no coincide" es la diferencia entre revisar la config
      // del proveedor o revisar el secreto.
      this.webhookLog.push('agente', `Webhook de ElevenLabs rechazado: ${auth.motivo}`, false);
      await this.webhookLog.flush();
      return { received: false };
    }

    const conversationId = payload.data?.conversation_id ?? payload.conversation_id;
    if (!conversationId) {
      this.webhookLog.push('agente', `Webhook de ElevenLabs sin conversation_id (${payload.type ?? 'sin tipo'})`, false);
      return { received: true };
    }

    const { nuevos, aviso } = await this.voz.traerTranscripcion(conversationId);
    this.webhookLog.push(
      'agente',
      aviso
        ? `Llamada terminada pero la transcripción no entró: ${aviso}`
        : `Llamada terminada: ${nuevos} turno(s) al hilo`,
      !aviso,
    );
    await this.webhookLog.flush();
    return { received: true, nuevos };
  }

  /**
   * Verifica la firma del webhook.
   *
   * `elevenlabs-signature` NO es el secreto en crudo: es un HMAC con el mismo
   * formato que usan Stripe y Svix — `t=<epoch>,v0=<hmac-sha256 hex>`, donde
   * lo firmado es `<t>.<cuerpo crudo>`.
   *
   * Se comparaba por IGUALDAD contra el secreto, así que nunca coincidía y
   * TODOS los webhooks de llamada se rechazaban en silencio: las llamadas
   * ocurrían, el agente contestaba, y a la app no llegaba ninguna.
   *
   * Fail-open sigue igual: sin secreto configurado no se exige nada, y se
   * empieza a exigir recién cuando está puesto de los dos lados.
   */
  private autorizado(req: FastifyRequest): { ok: boolean; motivo?: string } {
    if (!this.secreto) return { ok: true };

    const headers = req.headers as Record<string, string | undefined>;
    const firma = headers['elevenlabs-signature'] ?? headers['x-webhook-secret'] ?? '';
    if (!firma) return { ok: false, motivo: 'sin cabecera de firma' };

    const iguales = (a: string, b: string) => {
      const x = Buffer.from(a, 'utf-8');
      const y = Buffer.from(b, 'utf-8');
      return x.length === y.length && timingSafeEqual(x, y);
    };

    // Algunos montajes mandan el secreto tal cual en una cabecera propia.
    if (iguales(firma, this.secreto)) return { ok: true };

    const partes = Object.fromEntries(
      firma.split(',').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1)];
      }),
    ) as Record<string, string | undefined>;
    const t = partes['t'];
    const v0 = partes['v0'];
    if (!t || !v0) return { ok: false, motivo: 'firma sin t= o v0=' };

    /*
     * El HMAC va sobre el cuerpo CRUDO: re-serializar el JSON cambia espacios
     * y orden, y el hash deja de coincidir. NestFactory se levanta con
     * `rawBody: true` en los dos arranques, igual que para la firma de Meta.
     */
    const crudo = (req as FastifyRequest & { rawBody?: Buffer | string }).rawBody;
    if (!crudo) return { ok: false, motivo: 'no llegó el cuerpo crudo' };

    const esperado = createHmac('sha256', this.secreto)
      .update(`${t}.${typeof crudo === 'string' ? crudo : crudo.toString('utf-8')}`)
      .digest('hex');

    return iguales(v0, esperado) ? { ok: true } : { ok: false, motivo: 'la firma no coincide' };
  }
}
