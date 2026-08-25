import { Public } from '../auth/public.decorator';
import { BadRequestException, Body, Controller, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { FlowLogService } from '../shared/flow-log.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { NlpearlActivityStore } from './activity.store';
import { NlpearlCallApiView } from './nlpearl.client';
import { normalizarTranscript } from './nlpearl.mapper';
import { EscalamientoService } from './escalamiento.service';
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
/**
 * A quién avisa el flujo cuando un caso escala. Van acá y no escritos a mano
 * en cada nodo de NL Pearl: cambiar un número en el editor obliga a tocar
 * varios nodos y olvidarse de uno pasa desapercibido hasta la emergencia.
 *
 * Las cuatro compañías (CODEM, Infraestructura, Movilidad y Orden Público)
 * comparten número por ahora; cuando cada una tenga el suyo, esto se abre a
 * un mapa por compañía sin tocar el flujo.
 */
const DESTINOS = {
  alcaldeSms: '+50497616546',
  alcaldeCorreo: 'jorge.murcia@movitext.com',
  companias: '+50498288272',
};

@Public()
@Controller('webhooks')
export class NlpearlWebhookController {
  private readonly logger = new Logger(NlpearlWebhookController.name);

  constructor(
    private readonly sync: PearlSyncService,
    private readonly store: NlpearlActivityStore,
    private readonly flowLog: FlowLogService,
    private readonly webhookLog: WebhookLogService,
    private readonly escalamiento: EscalamientoService,
    private readonly brain: BrainService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
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
    const telefono =
      this.primerTexto(payload, ['phone', 'phoneNumber', 'from', 'to']) ??
      this.primerTexto(anidado, ['phone', 'phoneNumber', 'from', 'to']);

    // Siempre se deja rastro, aunque no se pueda procesar: es la única forma
    // de descubrir el shape de un evento nuevo sin adivinar.
    this.webhookLog.push('nlpearl', `Evento «${evento}» · ${this.referencia(payload, telefono)}`, true, payload);

    if (!id) {
      this.logger.warn(`Webhook sin id reconocible: ${JSON.stringify(payload).slice(0, 200)}`);
      throw new BadRequestException('No se encontró el id de la actividad en el webhook');
    }

    this.flowLog.push('webhook', `NL Pearl avisó: ${evento} · ${this.referencia(payload, telefono)}`);

    try {
      // Se pasa el cuerpo entero: si ya trae la conversación, se ingiere de
      // ahí sin llamar al API (los chats de texto no son consultables).
      const { nuevas, channel } = await this.sync.ingestCall(id, pearlId, payload);
      this.webhookLog.push(
        'nlpearl',
        nuevas
          ? `${nuevas} mensaje(s) de ${this.referencia(payload, telefono)} en el Brain (${channel})`
          : `Sin novedades de ${this.referencia(payload, telefono)} (ya estaba ingerida)`,
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
      this.webhookLog.push(
        'nlpearl',
        `No se pudo ingerir la conversación de ${this.referencia(payload, telefono)}: ${motivo}`,
        false,
        { id, pearlId },
      );
      return { received: true, procesado: false, motivo };
    }
  }

  /**
   * Todo lo que el flujo de la Pearl nos empuja, por cualquiera de sus dos
   * rutas históricas.
   *
   * Se decide por el CONTENIDO, no por la URL: si el cuerpo trae transcript es
   * la conversación completa (acción post-conversación), y si no, es un avance
   * del flujo (nodo API in-call, que solo puede mandar variables recopiladas —
   * NL Pearl no expone el texto de los turnos en vivo).
   *
   * Las dos rutas apuntan acá porque quien configura el flujo ya cambió la URL
   * de un nodo por la del otro una vez, y romper la ingesta por un campo mal
   * puesto en un editor externo no vale la pena. El shape del cuerpo distingue
   * los dos casos sin ambigüedad.
   */
  @Post(['nlpearl/turno', 'nlpearl/avance'])
  @UseGuards(TurnCredentialGuard)
  async onFlujo(@Body() body: unknown) {
    const p = (body ?? {}) as Record<string, unknown>;

    const conversationId = this.primerTexto(p, ['conversationId', 'callId', 'chatId', 'id']);
    const phone = this.primerTexto(p, ['phone', 'phoneNumber', 'from', 'to']);
    const pearlId = this.primerTexto(p, ['pearlId', 'projectId']);
    const paso = this.primerTexto(p, ['paso', 'step', 'node', 'nodeId']) ?? 'avance';

    if (!conversationId || !phone) {
      throw new BadRequestException('Faltan campos: conversationId y phone');
    }

    // ¿Conversación completa? Entonces son mensajes de verdad.
    const transcript = normalizarTranscript(p['transcript'] ?? p['post_call_transcript']);
    if (transcript?.length) {
      this.webhookLog.push('nlpearl', `Conversación cerrada · ${this.referencia(p, phone)}`, true, p);
      const nuevas = await this.ingerirConversacion(conversationId, pearlId, phone, transcript, p);
      return { received: true, conversacionCompleta: true, nuevas };
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

    /*
     * El contacto nace con el PRIMER avance, no con el primer mensaje. Sin
     * esto, una conversación recién abierta no aparecía en la consola hasta
     * que llegaba el chat — y el chat puede tardar toda la conversación. Con
     * el contacto creado, el hilo sale en Conversaciones de inmediato y la
     * vista Flujo va dibujando el recorrido en vivo. Si el flujo ya capturó
     * el nombre, se aprovecha; corregirlo después no pisa nada.
     */
    try {
      const { contactId } = await this.brain.resolveIdentity({ phone, system: 'nlpearl' });
      const nombre = typeof datos['nombreCiudadano'] === 'string' ? datos['nombreCiudadano'].trim() : '';
      if (nombre) {
        const ctx = await this.brain.getContext({ contactId });
        if (!ctx.contact.displayName) await this.brain.upsertContact({ id: contactId, displayName: nombre });
      }
    } catch (err) {
      // El avance ya quedó guardado: la identidad nunca lo tumba.
      this.logger.warn(`No se pudo crear el contacto del avance: ${(err as Error).message}`);
    }

    /*
     * Escalamiento sin tocar el flujo: el nodo `apiCollectLocation` ya manda
     * acá la ubicación y el teléfono en cada reporte, así que este es el
     * punto donde se puede saber si el incidente ya cruzó el umbral. Agregar
     * un nodo nuevo en el editor habría exigido reescribir los 58 nodos por
     * PUT y sacrificar un indicator tag; esto consigue lo mismo sin riesgo.
     */
    const ubicacion = typeof datos['ubicacion'] === 'string' ? datos['ubicacion'] : undefined;
    if (ubicacion) {
      await this.avisarSiEscala(ubicacion, phone, datos).catch((err) => {
        // Nunca tumbar el avance por un aviso: el reporte ya quedó guardado.
        this.logger.warn(`No se pudo evaluar escalamiento: ${(err as Error).message}`);
      });
    }

    const comoSeLlama = this.referencia(p, phone);
    this.webhookLog.push('nlpearl', `Avance «${this.pasoLegible(paso)}» · ${comoSeLlama}`, true, p);
    this.flowLog.push('webhook', `Avance ${this.pasoLegible(paso)} · ${comoSeLlama}`);
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
    this.webhookLog.push('nlpearl', `${nuevas} mensaje(s) de ${this.referencia(p, phone)}`, true, {
      conversationId,
      nuevas,
    });
    this.flowLog.push('webhook', `Conversación completa · ${this.referencia(p, phone)}`);
    return nuevas;
  }

  /**
   * Confirmación al ciudadano de que su reporte quedó registrado.
   *
   * Los nodos `notifyEmail` y `emNotifyEmail` del flujo ya llamaban a esta
   * ruta desde antes, pero NUNCA existió: devolvía 404 y el flujo seguía de
   * largo porque sus dos transiciones —éxito y error— van al mismo nodo, así
   * que el fallo era invisible. Ningún ciudadano recibió su folio.
   *
   * Responde 200 siempre: si la entrega falla, el reporte ya quedó
   * registrado igual y cortar la conversación por eso sería peor. El motivo
   * queda en el registro de Actividad.
   */
  @Post('nlpearl/notificar')
  @UseGuards(TurnCredentialGuard)
  async onNotificar(@Body() body: unknown) {
    const p = (body ?? {}) as Record<string, unknown>;
    const phone = this.primerTexto(p, ['phone', 'phoneNumber', 'to']);
    const folio = this.primerTexto(p, ['folio', 'hs_ticket_id']);
    const quien = this.referencia(p, phone);

    if (!phone) {
      this.webhookLog.push('nlpearl', 'Confirmación sin teléfono al que avisar', false, p);
      return { received: true, entregado: false, motivo: 'Falta phone' };
    }

    const texto =
      `Tu reporte quedó registrado${folio ? ` con el folio ${folio}` : ''}. ` +
      `Ya se notificó a los equipos correspondientes. Te avisaremos cada vez que haya novedades.`;

    let entregado = false;
    let motivo: string | undefined;
    try {
      const { contactId } = await this.brain.resolveIdentity({ phone, system: 'sender' });
      await this.whatsapp.send(contactId, texto);
      entregado = true;
    } catch (err) {
      motivo = (err as Error).message;
    }

    this.webhookLog.push(
      'nlpearl',
      entregado
        ? `Confirmación enviada a ${quien}${folio ? ` · folio ${folio}` : ''}`
        : `Confirmación NO entregada a ${quien}: ${motivo}`,
      entregado,
      { phone, folio },
    );
    return { received: true, entregado, folio, motivo };
  }

  /**
   * ¿Este incidente ya es crítico? Lo llama el nodo API del flujo justo
   * después de recopilar la ubicación.
   *
   * Devuelve todo PLANO y con el texto ya armado: los nodos de NL Pearl
   * mapean campos de la respuesta a variables, no saben concatenar. Así el
   * flujo solo ramifica por `escalar` y le pasa `mensaje` al nodo SMS.
   */
  @Post('nlpearl/escalamiento')
  @UseGuards(TurnCredentialGuard)
  async onEscalamiento(@Body() body: unknown) {
    const p = (body ?? {}) as Record<string, unknown>;
    const ubicacion = this.primerTexto(p, ['ubicacion', 'location', 'direccion']);
    if (!ubicacion) throw new BadRequestException('Falta `ubicacion`');

    const r = await this.escalamiento.evaluar({
      ubicacion,
      telefono: this.primerTexto(p, ['phone', 'phoneNumber', 'from', 'telefono']),
      obstruyePaso: this.primerTexto(p, ['obstruye_paso', 'obstruyePaso']),
      folio: this.primerTexto(p, ['folio', 'hs_ticket_id', 'ticketId']),
    });

    this.webhookLog.push(
      'nlpearl',
      r.escalar ? `ESCALA a despacho · ${r.motivo}` : `Sin escalar · ${r.motivo}`,
      true,
      { ubicacion, ...r },
    );

    return {
      ...r,
      // Destinatarios fijos, para que el flujo no los lleve escritos a mano
      // en cada nodo: cambiarlos acá los cambia en todo el flujo.
      telefonoAlcalde: DESTINOS.alcaldeSms,
      correoAlcalde: DESTINOS.alcaldeCorreo,
      telefonoCompanias: DESTINOS.companias,
    };
  }

  /**
   * Avisa por WhatsApp al despacho y a las compañías cuando el incidente
   * cruza el umbral E3_EXECUTIVE.
   *
   * Se manda una sola vez por incidente: sin esa marca, cada avance del
   * mismo reporte volvería a disparar el aviso y el alcalde recibiría veinte
   * mensajes del mismo derrumbe — exactamente el ruido que el guion quiere
   * evitar.
   */
  private async avisarSiEscala(
    ubicacion: string,
    phone: string,
    datos: Record<string, unknown>,
  ): Promise<void> {
    const r = await this.escalamiento.evaluar({
      ubicacion,
      telefono: phone,
      obstruyePaso: typeof datos['obstruye_paso'] === 'string' ? datos['obstruye_paso'] : undefined,
      folio: typeof datos['hs_ticket_id'] === 'string' ? datos['hs_ticket_id'] : undefined,
    });
    if (!r.escalar) return;

    const marca = `escalado:${ubicacion.toLowerCase().replace(/\s+/g, '-').slice(0, 60)}`;
    if (await this.store.findActivity(marca)) return;
    await this.store.recordActivity({
      id: marca,
      phone,
      kind: 'progress',
      occurredAt: new Date().toISOString(),
      raw: { paso: 'escalamiento', datos: { ubicacion, motivo: r.motivo } },
    });

    for (const [quien, numero] of [
      ['alcalde', DESTINOS.alcaldeSms],
      ['compañías', DESTINOS.companias],
    ] as const) {
      try {
        const { contactId } = await this.brain.resolveIdentity({ phone: numero, system: 'sender' });
        await this.whatsapp.send(contactId, r.mensaje);
        this.webhookLog.push('nlpearl', `Escalamiento avisado a ${quien} (${numero})`, true, r);
      } catch (err) {
        this.webhookLog.push(
          'nlpearl',
          `NO se pudo avisar a ${quien} (${numero}): ${(err as Error).message}`,
          false,
          r,
        );
      }
    }
  }

  /**
   * Cómo se nombra una conversación en el registro que ve el operador.
   *
   * Nunca por su id: un hexadecimal de 24 caracteres no le dice nada a nadie
   * y en la consola no se muestran identificadores. Se usa lo que sí
   * identifica al caso — quién es y por qué llamó — y si no hay nada, el
   * teléfono, que al menos se puede buscar.
   */
  private referencia(p: Record<string, unknown>, phone?: string): string {
    const texto = (clave: string): string | undefined => {
      const v = p[clave];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const quien = texto('nombreCiudadano') ?? texto('firstName');
    const que = texto('tipoProblema') ?? texto('tipoConsulta');
    if (quien && que) return `${quien} · ${que.toLowerCase()}`;
    if (quien) return quien;
    if (que && phone) return `${que.toLowerCase()} · ${phone}`;
    if (que) return que;
    return phone ?? 'conversación sin identificar';
  }

  /** Nombre técnico del nodo del flujo → algo que se pueda leer. */
  private static readonly PASOS: Record<string, string> = {
    opening: 'apertura',
    closing: 'cierre',
    emergency: 'emergencia',
    identifyNeed: 'identificó la necesidad',
    collectProblem: 'tipo de problema',
    collectLocation: 'ubicación',
    collectDesc: 'descripción',
    collectContact: 'datos de contacto',
    confirmInfo: 'confirmación',
    registered: 'reporte registrado',
    consultaTramite: 'orientación de trámite',
  };

  private pasoLegible(paso: string): string {
    return (
      NlpearlWebhookController.PASOS[paso] ??
      paso.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    );
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
