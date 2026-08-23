import { Public } from '../auth/public.decorator';
import { BadRequestException, Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { FlowLogService } from '../shared/flow-log.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { PearlSyncService } from './pearl-sync.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';

/**
 * POST /webhooks/nlpearl — NL Pearl avisa que una actividad terminó.
 *
 * Es lo que hace que el hilo aparezca EN VIVO: sin esto habría que esperar al
 * sondeo. Sirve igual para voz y para texto — `PearlSyncService.ingestCall`
 * resuelve el canal de la Pearl y aplica la ingesta correcta (una interacción
 * por llamada, o una por mensaje del chat).
 *
 * El id viaja con distinto nombre según el evento, así que se aceptan varias
 * formas y se registra el cuerpo crudo en la bitácora para poder inspeccionar
 * el shape real de cada tipo de evento.
 */
@Public()
@Controller('webhooks')
export class NlpearlWebhookController {
  private readonly logger = new Logger(NlpearlWebhookController.name);

  constructor(
    private readonly sync: PearlSyncService,
    private readonly flowLog: FlowLogService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  @Post('nlpearl')
  @UseGuards(WebhookSignatureGuard)
  async onActivityFinished(@Body() body: unknown) {
    const payload = (body ?? {}) as Record<string, unknown>;

    const id = this.primerTexto(payload, ['callId', 'id', 'conversationId', 'chatId']);
    const pearlId = this.primerTexto(payload, ['pearlId', 'projectId']);
    const evento = this.primerTexto(payload, ['event', 'type', 'eventType']) ?? 'actividad';

    // Siempre se deja rastro, aunque no se pueda procesar: es la única forma
    // de descubrir el shape de un evento nuevo sin adivinar.
    this.webhookLog.push('nlpearl', `Evento «${evento}»${id ? ` (${id})` : ''}`, true, payload);

    if (!id) {
      this.logger.warn(`Webhook sin id reconocible: ${JSON.stringify(payload).slice(0, 200)}`);
      throw new BadRequestException('No se encontró el id de la actividad en el webhook');
    }

    this.flowLog.push('webhook', `NL Pearl avisó: ${evento} ${id}`);

    try {
      const { nuevas, channel } = await this.sync.ingestCall(id, pearlId);
      this.webhookLog.push(
        'nlpearl',
        nuevas
          ? `${nuevas} mensaje(s)/llamada nueva de ${id} en el Brain (${channel})`
          : `Sin novedades en ${id} (ya estaba ingerida)`,
        true,
        { id, nuevas, channel },
      );
      return { received: true, nuevas };
    } catch (err) {
      // Se acusa recibo igual (200): devolver error dejaría el webhook marcado
      // como fallido en NL Pearl, y el sondeo periódico es la red de seguridad
      // que recupera la conversación de todos modos. El motivo queda en la
      // bitácora para diagnosticarlo desde la consola.
      const motivo = (err as Error).message;
      this.logger.warn(`No se pudo ingerir ${id}: ${motivo}`);
      this.webhookLog.push('nlpearl', `No se pudo ingerir ${id}: ${motivo}`, false, { id, pearlId });
      return { received: true, procesado: false, motivo };
    }
  }

  /** Primer campo con texto útil entre varios nombres posibles. */
  private primerTexto(payload: Record<string, unknown>, claves: string[]): string | undefined {
    for (const clave of claves) {
      const valor = payload[clave];
      if (typeof valor === 'string' && valor.trim()) return valor.trim();
    }
    return undefined;
  }
}
