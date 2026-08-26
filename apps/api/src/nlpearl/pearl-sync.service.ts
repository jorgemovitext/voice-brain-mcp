import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BrainService } from "../brain/brain.service";
import { Channel } from "../brain/types";
import { FlowLogService } from "../shared/flow-log.service";
import { NlpearlActivityStore, StoredPearl } from "./activity.store";
import { NlpearlCallApiView, NlpearlClient } from "./nlpearl.client";
import {
  canalDePearl,
  normalizarTranscript,
  PearlChannel,
  toCallContext,
  toChatMessages,
} from "./nlpearl.mapper";

export interface SyncReport {
  pearls: number;
  actividades: number;
  /** Interacciones nuevas en el Brain (en texto, mensajes sueltos). */
  nuevas: number;
  errores: Array<{ pearlId: string; name?: string; error: string }>;
  desde: string;
  hasta: string;
}

/** Forma parcial del Pearl en GET /v2/Pearl. */
interface PearlApiView {
  id: string;
  name?: string;
  status?: number; // 1 = activa, 2 = pausada
  type?: number; // 1 = inbound, 2 = outbound
  [key: string]: unknown;
}

/**
 * El "espejo NL Pearl": recorre TODAS las pearls de la cuenta (voz y texto),
 * trae la actividad del rango, guarda el detalle raw en nuestra DB y alimenta
 * el Brain.
 *
 * Voz → una interacción por llamada (con su transcripción completa).
 * Texto → una interacción POR MENSAJE, para que el hilo se vea como el chat
 * que es: lo que escribe la persona entra como `inbound` y lo que contesta la
 * Pearl como `outbound`, o sea, nuestra app mostrando al agente respondiendo.
 *
 * Serverless: no hay timers de fondo, así que el sync se dispara por endpoint
 * (la consola lo invoca al refrescar, o manualmente / cron externo).
 */
@Injectable()
export class PearlSyncService {
  private readonly logger = new Logger(PearlSyncService.name);
  private readonly textPearlIds: Set<string>;
  /** Rate-limit por instancia: la consola sondea seguido y NL Pearl no es gratis. */
  private lastSyncAt = 0;
  private static readonly MIN_INTERVAL_MS = 30_000;
  /** Ventana corta: revisa solo las pearls activas, para ver el hilo en vivo. */
  private static readonly LIVE_INTERVAL_MS = 8_000;
  /** Último intento de rescate por conversación, para no pedir en cada sondeo. */
  private readonly rescates = new Map<string, number>();
  /*
   * 15 s y no 45: con el sondeo rápido pidiendo esto en cada vuelta, la
   * ventana es lo único que decide cuánto tarda en aparecer una conversación
   * recién cerrada. Cuarenta y cinco segundos se sentían como que la app no
   * se había enterado. El costo es una consulta por conversación abierta cada
   * 15 s, que para una línea con pocas conversaciones simultáneas es nada.
   */
  private static readonly RESCATE_MS = 15_000;

  constructor(
    private readonly client: NlpearlClient,
    private readonly store: NlpearlActivityStore,
    private readonly brain: BrainService,
    private readonly flowLog: FlowLogService,
    config: ConfigService,
  ) {
    this.textPearlIds = new Set(
      config
        .get<string>("NLPEARL_TEXT_PEARL_IDS", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  /**
   * Canal del Brain para los hilos de una pearl. `NLPEARL_TEXT_PEARL_IDS`
   * fuerza texto para casos que la detección automática no cubra.
   */
  private canalDe(pearl: PearlApiView, agentType?: number): PearlChannel {
    if (this.textPearlIds.has(pearl.id)) return canalDePearl(pearl.name, 2);
    return canalDePearl(pearl.name, agentType);
  }

  /** La API puede devolver el array pelado o envuelto ({results}/{data}). */
  private desenvolver<T>(res: unknown): T[] {
    if (Array.isArray(res)) return res as T[];
    const wrapped = res as { results?: T[]; data?: T[]; items?: T[] } | null;
    return wrapped?.results ?? wrapped?.data ?? wrapped?.items ?? [];
  }

  /**
   * Sync a demanda, con rate-limit para poder colgarlo del refresh de la consola.
   *
   * Dos velocidades: cada ~8 s se revisan SOLO las pearls activas (son pocas y
   * es lo que está pasando ahora mismo), y cada ~30 s se recorre la cuenta
   * completa. Así una conversación en curso aparece casi al instante sin
   * castigar al API con 20+ pearls dormidas.
   */
  async syncIfDue(hours = 24): Promise<SyncReport | { skipped: true }> {
    const desde = Date.now() - this.lastSyncAt;
    if (desde < PearlSyncService.LIVE_INTERVAL_MS) return { skipped: true };
    if (desde < PearlSyncService.MIN_INTERVAL_MS)
      return this.syncAll({ hours: 2, soloActivas: true });
    return this.syncAll({ hours });
  }

  /**
   * Trae la conversación por su id — desde el PRIMER avance, no solo al
   * cierre.
   *
   * El flujo manda avances en vivo (variables, no texto) y NL Pearl promete
   * el hilo completo al terminar, por un aviso que llega UNA vez y sin
   * reintentos. Pero el `conversationId` de cada avance ES el callId, así que
   * pedirla temprano y seguido llena el chat con los turnos que ya existan y,
   * de paso, cubre el aviso de cierre perdido. Los listados (`/Calls`,
   * `/Calls/Bulk`) responden cero para esta cuenta; el detalle por id es la
   * única ruta que entrega.
   *
   * Si todavía no hay turnos, no pasa nada: se reintenta en el siguiente
   * sondeo (con el throttle de abajo, para no castigar al API).
   */
  async rescatarConversacion(conversationId: string, etiqueta?: string): Promise<number> {
    // Los ids de NL Pearl son ObjectId de 24 hex; los del simulador no, y
    // pedirlos devuelve 400.
    if (!/^[0-9a-f]{24}$/i.test(conversationId)) return 0;

    const ahora = Date.now();
    if (ahora - (this.rescates.get(conversationId) ?? 0) < PearlSyncService.RESCATE_MS) return 0;
    this.rescates.set(conversationId, ahora);

    try {
      const { nuevas } = await this.ingestCall(conversationId);
      if (nuevas) {
        this.flowLog.push(
          'sync',
          `Conversación de ${etiqueta ?? 'un ciudadano'} recuperada del API: ${nuevas} mensaje(s)`,
        );
      }
      return nuevas;
    } catch (err) {
      // Lo normal mientras la conversación sigue abierta: no es un error.
      this.logger.debug(`Sin conversación todavía: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Ingesta inmediata de UNA conversación (la dispara el webhook de NL Pearl).
   * Es lo que hace que el hilo aparezca en vivo sin esperar al sondeo.
   */
  async ingestCall(
    callId: string,
    pearlIdHint?: string,
    /**
     * Cuerpo del webhook. Si ya trae la conversación (transcript/mensajes) se
     * usa tal cual: los chats de texto NO se pueden recuperar con getCall —
     * la API los reporta en cero aunque existan— así que el payload del
     * webhook es la única fuente para ellos.
     */
    payload?: Record<string, unknown>,
  ): Promise<{ nuevas: number; channel?: Channel }> {
    const delPayload = this.conversacionDelPayload(payload);
    const crudo =
      delPayload ?? ((await this.client.getCall(callId)) as NlpearlCallApiView);

    // El webhook identifica la conversación como `callId`, no como `id`: sin
    // normalizarlo, cada turno se guardaba bajo `nlpearl:undefined:N` y la
    // conversación siguiente chocaba con esos mismos ids — sus mensajes se
    // descartaban por "ya ingeridos".
    const call: NlpearlCallApiView = { ...crudo, id: crudo.id || callId };
    if (!call.id) return { nuevas: 0 };

    const pearlId = pearlIdHint ?? call.pearlId;
    if (!pearlId) return { nuevas: 0 };

    const { channel, nombre, type } = await this.resolverPearl(pearlId);

    // Si el payload trae la conversación entera, es la versión autoritativa:
    // pisa lo ingerido turno a turno desde el nodo API del flujo (mismo
    // esquema de ids), en vez de dejar dos copias del hilo.
    const nuevas = await this.ingestar({ id: pearlId, name: nombre, type }, channel, call, {
      overwrite: Boolean(delPayload),
    });
    return { nuevas, channel };
  }

  /** Canal, nombre y tipo de una Pearl: del espejo local, o del API si falta. */
  private async resolverPearl(
    pearlId: string,
  ): Promise<{ channel: Channel; nombre?: string; type?: number }> {
    const stored = (await this.store.listPearls()).find((p) => p.id === pearlId);
    let channel = stored?.channel as Channel | undefined;
    let nombre = stored?.name;
    let type = stored?.type;

    if (!channel || !nombre) {
      // Pearl aún no espejada: se resuelve contra el API.
      const [detalle, settings] = await Promise.all([
        this.client.getPearl(pearlId).catch(() => null) as Promise<PearlApiView | null>,
        this.client.getPearlSettings(pearlId).catch(() => null),
      ]);
      nombre = nombre ?? detalle?.name;
      channel = channel ?? canalDePearl(detalle?.name, settings?.agentType);
      type = type ?? detalle?.type;
    }

    return { channel: channel ?? 'whatsapp', nombre, type };
  }

  /**
   * ¿El webhook trae la conversación completa? Se acepta `transcript` o
   * `messages` (NL Pearl no documenta el shape de los eventos de texto).
   */
  private conversacionDelPayload(
    payload?: Record<string, unknown>,
  ): NlpearlCallApiView | undefined {
    if (!payload) return undefined;
    const crudo = (payload["call"] ??
      payload["conversation"] ??
      payload) as Record<string, unknown>;
    const turnos = (crudo["transcript"] ??
      crudo["messages"] ??
      crudo["chat"]) as unknown;
    if (!Array.isArray(turnos) || !turnos.length) return undefined;

    return {
      ...(crudo as unknown as NlpearlCallApiView),
      transcript: turnos as NlpearlCallApiView["transcript"],
    };
  }

  async syncAll(
    opts: { hours?: number; pearlId?: string; soloActivas?: boolean } = {},
  ): Promise<SyncReport> {
    this.client.assertAccountConfigured();
    this.lastSyncAt = Date.now();

    const hasta = new Date();
    const desde = new Date(hasta.getTime() - (opts.hours ?? 24) * 3600 * 1000);
    const report: SyncReport = {
      pearls: 0,
      actividades: 0,
      nuevas: 0,
      errores: [],
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
    };

    let pearls = this.desenvolver<PearlApiView>(await this.client.getPearls());
    if (opts.pearlId) pearls = pearls.filter((p) => p.id === opts.pearlId);
    // status 1 = activa: las pausadas no pueden tener actividad nueva.
    if (opts.soloActivas) pearls = pearls.filter((p) => p.status === 1);

    // agentType ya conocido: evita re-consultar Settings de las 20+ pearls
    // en cada sync (el dato no cambia).
    const conocidas = new Map(
      (await this.store.listPearls()).map((p) => [p.id, p]),
    );

    for (const pearl of pearls) {
      report.pearls++;
      let agentType = conocidas.get(pearl.id)?.agentType;
      if (agentType === undefined) {
        const settings = await this.client
          .getPearlSettings(pearl.id)
          .catch(() => null);
        agentType = settings?.agentType;
      }

      const channel = this.canalDe(pearl, agentType);
      await this.store.upsertPearl({
        id: pearl.id,
        name: pearl.name,
        type: pearl.type,
        status: pearl.status,
        agentType,
        channel,
        raw: pearl,
      });

      try {
        // El API acepta limit máximo 100 (validado contra el server real):
        // se pagina con skip hasta agotar el rango.
        const PAGE = 100;
        for (let skip = 0; ; skip += PAGE) {
          const calls = this.desenvolver<NlpearlCallApiView>(
            await this.client.getCallsBulk(pearl.id, {
              fromDate: desde.toISOString(),
              toDate: hasta.toISOString(),
              skip,
              limit: PAGE,
            }),
          );
          for (const call of calls) {
            report.actividades++;
            report.nuevas += await this.ingestar(pearl, channel, call);
          }
          if (calls.length < PAGE) break;
        }
      } catch (err) {
        // Una pearl con error (p.ej. sin permisos o sin actividad soportada)
        // no debe frenar el resto del recorrido.
        report.errores.push({
          pearlId: pearl.id,
          name: pearl.name,
          error: (err as Error).message,
        });
      }
    }

    if (report.nuevas > 0) {
      this.flowLog.push(
        "brain",
        `Sincronización: ${report.nuevas} mensaje(s)/llamada(s) nueva(s) de ${report.pearls} agentes`,
        { nuevas: report.nuevas, pearls: report.pearls },
      );
    }
    this.logger.log(
      `Sync NL Pearl: ${report.pearls} pearls, ${report.actividades} actividades (${report.nuevas} nuevas), ${report.errores.length} errores`,
    );
    return report;
  }

  /**
   * Inyecta una conversación de texto como si la hubiera traído el sync.
   * Usa exactamente el mismo camino de ingesta que una real (`ingestarChat`),
   * así que sirve para validar cómo se ve el hilo en la consola sin depender
   * de que alguien escriba a la Pearl.
   */
  async simulateChat(input: {
    phone: string;
    channel?: Extract<Channel, "sms" | "whatsapp">;
    displayName?: string;
    mensajes: Array<{ role: "agent" | "customer"; content: string }>;
  }): Promise<{ callId: string; nuevas: number }> {
    const callId = `sim_chat_${Date.now().toString(36)}`;
    const inicio = new Date(Date.now() - input.mensajes.length * 30_000);

    const call: NlpearlCallApiView = {
      id: callId,
      from: input.phone,
      to: input.phone,
      direction: "inbound",
      startTime: inicio.toISOString(),
      transcript: input.mensajes.map((m, i) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
        startTime: i * 30,
      })),
      collectedInfo: input.displayName
        ? [{ id: "n", name: "First Name", value: input.displayName }]
        : undefined,
      overallSentiment: 4,
    };

    await this.store.recordActivity({
      id: callId,
      phone: input.phone,
      kind: "chat",
      occurredAt: inicio.toISOString(),
      raw: call,
    });
    const nuevas = await this.ingestarChat(
      input.channel ?? "whatsapp",
      call,
      input.phone,
    );
    return { callId, nuevas };
  }

  /**
   * Vuelve a proyectar al Brain las conversaciones de texto YA guardadas,
   * pisando lo que se ingirió antes.
   *
   * Existe porque la API no permite releer los chats (solo llegan por webhook):
   * el raw almacenado es la única copia, así que cuando un mapeo estaba mal
   * —como el rol numérico que ponía las respuestas del agente del lado del
   * cliente— este es el camino para corregir el historial.
   */
  async reprocesarChats(
    limite = 500,
  ): Promise<{ conversaciones: number; mensajes: number }> {
    const guardadas = await this.store.listActivity({ limit: limite });
    const pearls = await this.store.listPearls();
    const nombrePorId = new Map(pearls.map((p) => [p.id, p.name]));
    const canalPorId = new Map(pearls.map((p) => [p.id, p.channel]));

    let conversaciones = 0;
    let mensajes = 0;
    for (const act of guardadas) {
      if (act.kind !== "chat") continue;
      let call = act.raw as NlpearlCallApiView & { post_call_transcript?: unknown };
      const phone = act.phone ?? toCallContext(call).phoneNumber;
      if (!phone || !call?.id) continue;

      /*
       * `conversacionDelPayload` guarda el raw completo del webhook, así que
       * el texto ORIGINAL de `post_call_transcript` sigue ahí aunque el
       * `transcript` ya normalizado (posiblemente con el bug de las
       * etiquetas entre corchetes en una sola línea) se haya guardado
       * también. Reprocesar vuelve a partir ese texto con el parser
       * corregido en vez de confiar en el array ya roto.
       */
      if (typeof call.post_call_transcript === "string" && call.post_call_transcript.trim()) {
        call = { ...call, transcript: normalizarTranscript(call.post_call_transcript) };
      }

      const canal = (canalPorId.get(act.pearlId ?? "") ??
        "whatsapp") as Channel;
      mensajes += await this.ingestarChat(
        canal,
        call,
        phone,
        nombrePorId.get(act.pearlId ?? ""),
        {
          overwrite: true,
        },
      );
      conversaciones++;
    }

    this.logger.log(
      `Reingesta: ${conversaciones} conversación(es), ${mensajes} mensaje(s) corregidos`,
    );
    return { conversaciones, mensajes };
  }

  /**
   * Guarda el raw y refleja la actividad en el Brain.
   * Devuelve cuántas interacciones NUEVAS se crearon (0 si ya estaba todo).
   */
  private async ingestar(
    pearl: PearlApiView,
    channel: Channel,
    call: NlpearlCallApiView,
    /** La conversación completa pisa lo que se vio turno a turno. */
    opciones?: { overwrite?: boolean },
  ): Promise<number> {
    // Dirección: si el CallApiView no la trae, se hereda del tipo de pearl
    // (inbound recibe, outbound llama).
    const conDireccion: NlpearlCallApiView = {
      ...call,
      direction: call.direction ?? (pearl.type === 2 ? "outbound" : "inbound"),
    };
    const ctx = toCallContext(conDireccion);

    // Siempre se refresca el raw: una conversación en curso crece entre syncs
    // (primero llega sin transcript, después con más mensajes).
    await this.store.recordActivity({
      id: call.id,
      pearlId: pearl.id,
      phone: ctx.phoneNumber,
      kind: channel === "voice" ? "call" : "chat",
      occurredAt: ctx.endedAt ?? ctx.startedAt,
      raw: call,
    });

    if (!ctx.phoneNumber) return 0; // sin teléfono no hay identidad que resolver

    if (channel === "voice") {
      // Una llamada ya ingerida no se reprocesa (el id es determinista).
      if (await this.brain.getInteraction(`nlpearl:${call.id}`)) return 0;
      await this.brain.recordCallContext(ctx);
      return 1;
    }

    return this.ingestarChat(channel, conDireccion, ctx.phoneNumber, pearl.name, opciones);
  }

  /**
   * Conversación de texto → un mensaje del chat por cada turno, con el rol
   * traducido a dirección: la Pearl contestando sale como `outbound`, que es
   * como la consola pinta "nuestro agente respondió".
   */
  private async ingestarChat(
    channel: Channel,
    call: NlpearlCallApiView,
    phone: string,
    handledBy?: string,
    /** Reingesta: pisa lo ya proyectado en vez de saltearlo. */
    opciones?: { overwrite?: boolean },
  ): Promise<number> {
    const ctx = toCallContext(call);
    const mensajes = toChatMessages(call);

    const { contactId } = await this.brain.resolveIdentity({
      phone,
      externalId: ctx.externalId,
      system: "nlpearl",
    });

    // Nombre capturado por el agente durante el chat: enriquece el contacto.
    const nombre = this.nombreDe(ctx.collectedInfo);
    if (nombre) {
      const contacto = await this.brain.getContext({ contactId });
      if (!contacto.contact.displayName) {
        await this.brain.upsertContact({ id: contactId, displayName: nombre });
      }
    }

    // Sin transcript todavía (conversación recién abierta): se registra el
    // resumen como una sola interacción para que el hilo no quede vacío.
    if (!mensajes.length) {
      const id = `nlpearl:${call.id}`;
      if (!opciones?.overwrite && (await this.brain.getInteraction(id)))
        return 0;
      if (!ctx.summary) return 0;
      await this.brain.appendInteraction(
        {
          id,
          contactId,
          channel,
          direction: ctx.direction ?? "inbound",
          occurredAt: ctx.startedAt ?? new Date().toISOString(),
          summary: ctx.summary,
          source: "nlpearl",
          handledBy,
        },
        opciones,
      );
      return 1;
    }

    let nuevas = 0;
    for (const [i, mensaje] of mensajes.entries()) {
      // Id por turno: al re-sincronizar una conversación en curso solo entran
      // los mensajes que aún no estaban.
      const id = `nlpearl:${call.id}:${i}`;
      if (!opciones?.overwrite && (await this.brain.getInteraction(id)))
        continue;

      await this.brain.appendInteraction(
        {
          id,
          contactId,
          channel,
          direction: mensaje.role === "agent" ? "outbound" : "inbound",
          occurredAt: mensaje.at,
          summary: mensaje.content,
          source: "nlpearl",
          // Quién contestó: con varios agentes conviviendo, es parte del hilo.
          handledBy,
          // Foto o ubicación de WhatsApp: el turno llegó sin texto.
          attachment: mensaje.adjunto,
          // El análisis de la conversación (sentimiento, datos capturados) se
          // cuelga del último mensaje, que es cuando NL Pearl ya lo calculó.
          sentiment: i === mensajes.length - 1 ? ctx.sentiment : undefined,
          collectedInfo:
            i === mensajes.length - 1 ? ctx.collectedInfo : undefined,
        },
        opciones,
      );
      nuevas++;
    }
    return nuevas;
  }

  /** Busca un nombre entre los datos capturados, sin confundirlo con el del agente. */
  private nombreDe(
    collectedInfo?: Record<string, unknown>,
  ): string | undefined {
    if (!collectedInfo) return undefined;
    for (const [clave, valor] of Object.entries(collectedInfo)) {
      if (typeof valor !== "string" || !valor.trim()) continue;
      if (/agent/i.test(clave)) continue;
      if (
        /^(first\s*name|contact\s*name|nombre|full\s*name)$/i.test(clave.trim())
      )
        return valor.trim();
    }
    return undefined;
  }
}
