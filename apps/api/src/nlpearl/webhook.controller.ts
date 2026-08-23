import { Public } from '../auth/public.decorator';
import { BadRequestException, Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { FlowLogService } from '../shared/flow-log.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { NlpearlActivityStore } from './activity.store';
import { NlpearlCallApiView } from './nlpearl.client';
import { normalizarTranscript } from './nlpearl.mapper';
import { PearlSyncService } from './pearl-sync.service';
import { TurnCredentialGuard } from './turn-credential.guard';
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
    private readonly store: NlpearlActivityStore,
    private readonly flowLog: FlowLogService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  @Post('nlpearl')
  @UseGuards(WebhookSignatureGuard)
  async onActivityFinished(@Body() body: unknown) {
    const payload = (body ?? {}) as Record<string, unknown>;

    const anidado = (payload['call'] ?? payload['conversation'] ?? {}) as Record<string, unknown>;
    const id =
      this.primerTexto(payload, ['callId', 'id', 'conversationId', 'chatId']) ??
      this.primerTexto(anidado, ['id', 'callId', 'conversationId']);
    const pearlId =
      this.primerTexto(payload, ['pearlId', 'projectId']) ??
      this.primerTexto(anidado, ['pearlId', 'projectId']);
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
      // Se pasa el cuerpo entero: si ya trae la conversación, se ingiere de
      // ahí sin llamar al API (los chats de texto no son consultables).
      const { nuevas, channel } = await this.sync.ingestCall(id, pearlId, payload);
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

  /**
   * POST /webhooks/nlpearl/turno — la conversación completa, al cerrarse.
   *
   * Lo llama la acción post-conversación del flujo, con `post_call_transcript`
   * y compañía. Es la ÚNICA vía para traer un chat de texto: la API no permite
   * leerlos y el Call Webhook no dispara para pearls de texto.
   *
   * La ruta se llama `/turno` por historia: se creó pensando en recibir un
   * mensaje por vez, hasta confirmar que NL Pearl no expone el texto de los
   * turnos en vivo. Se conserva el nombre porque es la URL ya configurada en
   * el flujo y renombrarla solo rompería la única ingesta que funciona.
   */
  @Post('nlpearl/turno')
  @UseGuards(TurnCredentialGuard)
  async onConversacionCerrada(@Body() body: unknown) {
    const p = (body ?? {}) as Record<string, unknown>;

    const conversationId = this.primerTexto(p, ['conversationId', 'callId', 'chatId', 'id']);
    const phone = this.primerTexto(p, ['phone', 'phoneNumber', 'from', 'to']);
    const pearlId = this.primerTexto(p, ['pearlId', 'projectId']);

    this.webhookLog.push('nlpearl', `Conversación cerrada${conversationId ? ` (${conversationId})` : ''}`, true, p);

    const faltan = [
      ['conversationId', conversationId],
      ['phone', phone],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (faltan.length) {
      throw new BadRequestException(`Faltan campos: ${faltan.join(', ')}`);
    }

    const transcript = normalizarTranscript(p['transcript'] ?? p['post_call_transcript']);
    if (!transcript?.length) {
      throw new BadRequestException('Falta la transcripción de la conversación');
    }

    const nuevas = await this.ingerirConversacion(conversationId!, pearlId, phone!, transcript, p);
    return { received: true, nuevas };
  }

  /**
   * POST /webhooks/nlpearl/avance — el flujo avanzó un paso.
   *
   * Los nodos API in-call de NL Pearl NO pueden mandar el texto de los
   * mensajes: solo las variables que el flujo recopila. Así que esto no es
   * una conversación, es el ESTADO de una: "ya recopiló la ubicación", "ya
   * tiene el tipo de problema". Se guarda aparte de las interacciones a
   * propósito — meterlo en el hilo sería inventar mensajes que nadie escribió.
   *
   * Los nombres de los campos los define quien arma el nodo, así que todo lo
   * que no sea de control se guarda como dato capturado, sin exigir un shape.
   */
  @Post('nlpearl/avance')
  @UseGuards(TurnCredentialGuard)
  async onAvance(@Body() body: unknown) {
    const p = (body ?? {}) as Record<string, unknown>;

    const conversationId = this.primerTexto(p, ['conversationId', 'callId', 'chatId', 'id']);
    const phone = this.primerTexto(p, ['phone', 'phoneNumber', 'from']);
    const pearlId = this.primerTexto(p, ['pearlId', 'projectId']);
    const paso = this.primerTexto(p, ['paso', 'step', 'node', 'nodeId']) ?? 'avance';

    if (!conversationId || !phone) {
      throw new BadRequestException('Faltan campos en el avance: conversationId y phone');
    }

    const CONTROL = new Set(['conversationId', 'callId', 'chatId', 'id', 'phone', 'phoneNumber', 'from', 'pearlId', 'projectId', 'paso', 'step', 'node', 'nodeId']);
    const datos = Object.fromEntries(
      Object.entries(p).filter(([k, v]) => !CONTROL.has(k) && v !== null && v !== ''),
    );

    // Un registro por paso y conversación: si el flujo repite el mismo paso
    // (el ciudadano corrige la ubicación), se actualiza en vez de acumular.
    await this.store.recordActivity({
      id: `avance:${conversationId}:${paso}`,
      pearlId,
      phone,
      kind: 'progress',
      occurredAt: new Date().toISOString(),
      raw: { conversationId, paso, datos },
    });

    this.webhookLog.push('nlpearl', `Avance «${paso}» en ${conversationId}`, true, p);
    this.flowLog.push('webhook', `Avance ${paso} · ${Object.keys(datos).join(', ') || 'sin datos'}`);
    return { received: true, paso, datos: Object.keys(datos) };
  }

  /**
   * Ingiere la conversación completa que llega desde una acción
   * post-conversación, reusando el mismo camino que el Call Webhook: mismo
   * esquema de ids, así que reescribe los turnos ya vistos en vez de duplicar.
   */
  private async ingerirConversacion(
    conversationId: string,
    pearlId: string | undefined,
    phone: string,
    transcript: NonNullable<NlpearlCallApiView['transcript']>,
    p: Record<string, unknown>,
  ): Promise<number> {
    const { nuevas } = await this.sync.ingestCall(conversationId, pearlId, {
      ...p,
      id: conversationId,
      // El teléfono del ciudadano llega en un solo campo; el mapeo de
      // dirección espera `from` en las entrantes.
      from: phone,
      direction: 'inbound',
      transcript,
      summary: p['summary'] ?? p['post_call_summary'],
    });
    this.webhookLog.push('nlpearl', `Conversación ${conversationId}: ${nuevas} mensaje(s)`, true, {
      conversationId,
      nuevas,
    });
    this.flowLog.push('webhook', `Conversación completa ${conversationId} (${nuevas})`);
    return nuevas;
  }

  /**
   * Primer campo con texto útil entre varios nombres posibles. Acepta números
   * porque el nodo API castea cada variable a su tipo configurado, y un rol o
   * un id pueden llegar como número.
   */
  private primerTexto(payload: Record<string, unknown>, claves: string[]): string | undefined {
    for (const clave of claves) {
      const valor = payload[clave];
      if (typeof valor === 'string' && valor.trim()) return valor.trim();
      if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
    }
    return undefined;
  }
}
