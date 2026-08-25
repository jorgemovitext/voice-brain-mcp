import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { Channel, Interaction } from '../brain/types';
import { IntegrationsService } from '../integrations/integrations.service';
import { NlpearlActivityStore } from './activity.store';
import { NlpearlClient } from './nlpearl.client';
import { PearlRoutingService } from './pearl-routing.service';

/** Un hilo cuyo último mensaje es del cliente: alguien espera al enjambre. */
export interface WaitingThread {
  contactId: string;
  displayName?: string;
  phone?: string;
  channel: Channel;
  summary?: string;
  occurredAt: string;
  /** Minutos esperando desde el último mensaje del cliente. */
  waitingMin: number;
}

export interface HiveStatus {
  obreros: {
    total: number;
    activos: number;
    /** Activos con canal/número por donde recibir. */
    enElPanal: Array<{
      id: string;
      name: string;
      channel: Channel;
      /** Conversaciones ya espejadas de esta pearl. */
      synced: number;
      asignada?: boolean;
    }>;
  };
  metricas: {
    contactos: number;
    conversacionesHoy: number;
    esperandoRespuesta: number;
    promesasActivas: number;
    /** Hilos al día: el último mensaje lo puso el enjambre. */
    hilosAlDia: number;
    /** La espera más larga de la cola, en minutos (0 si nadie espera). */
    maxEsperaMin: number;
    /** Interacciones de hoy por hora (24 casillas) para el sparkline. */
    porHora: number[];
  };
  /** Tráfico total por canal, para el mapa de flujo. */
  porCanal: Array<{ channel: Channel; total: number; inbound: number }>;
  /**
   * Pulso en vivo del WhatsApp de NL Pearl: cuántas conversaciones tiene
   * abiertas AHORA MISMO, según su propia API — no nuestra base de datos.
   *
   * `null` significa "no se pudo consultar" (sin Pearl asignada al canal, o
   * la API no respondió), y se distingue a propósito de `0`: un cero real
   * dice "nadie está escribiendo ahora"; un null dice "no lo sabemos". Nunca
   * se lista quién ni qué dice — la API de NL Pearl no expone eso para
   * conversaciones de texto, solo el conteo.
   */
  enVivo: { total: number; enCola: number | null } | null;
  esperando: WaitingThread[];
  actividad: Array<{
    contactId: string;
    displayName?: string;
    channel: Channel;
    direction: 'inbound' | 'outbound';
    summary?: string;
    occurredAt: string;
    source?: string;
  }>;
  canales: {
    nlpearl: boolean;
    /** Canal de texto de NL Pearl por el que conversan los AGENTES (o null). */
    whatsappAgentes: string | null;
    /** Proveedor de entrega de OTP (Gupshup); los agentes NO salen por acá. */
    otp: string;
    db: 'postgres' | 'blob' | 'archivo';
  };
}

/**
 * El estado de la colmena en una sola lectura: qué obreros están en el panal,
 * quién está esperando respuesta y qué acaba de pasar. Es lo que alimenta la
 * primera pantalla — el lugar desde donde se OPERA el enjambre, no un saludo.
 */
@Injectable()
export class HiveService {
  private readonly dbMode: HiveStatus['canales']['db'];
  private readonly nlpearlOk: boolean;
  private readonly mock: boolean;

  /** Canal de texto NL Pearl, cacheado: cambia casi nunca y el panel refresca cada 5 s. */
  private textChannelCache: { value: string | null; at: number } | null = null;

  /**
   * El pulso en vivo, cacheado 4 s: el panel sondea cada 5 s, y con varias
   * pestañas abiertas cada una dispararía su propia consulta a NL Pearl al
   * mismo tiempo. La caché las junta en una sola llamada real.
   */
  private enVivoCache: { value: HiveStatus['enVivo']; at: number } | null = null;
  private static readonly EN_VIVO_TTL_MS = 4_000;

  constructor(
    private readonly brain: BrainService,
    private readonly store: NlpearlActivityStore,
    private readonly routing: PearlRoutingService,
    private readonly integrations: IntegrationsService,
    private readonly client: NlpearlClient,
    config: ConfigService,
  ) {
    this.mock = config.get<boolean>('MOCK', true);
    this.dbMode = config.get<string>('DATABASE_URL')
      ? 'postgres'
      : config.get<string>('BLOB_READ_WRITE_TOKEN')
        ? 'blob'
        : 'archivo';
    this.nlpearlOk = (() => {
      try {
        client.assertAccountConfigured();
        return true;
      } catch {
        return false;
      }
    })();
  }

  async status(): Promise<HiveStatus> {
    const [contactos, interacciones, pearls, counts, routing] = await Promise.all([
      this.brain.listContacts(),
      this.brain.listInteractions(),
      this.store.listPearls(),
      this.store.countsByPearl(),
      this.routing.all(),
    ]);
    // Depende de `routing.whatsapp`: va después, no dentro del Promise.all de arriba.
    const enVivo = await this.enVivoAhora(routing.whatsapp);

    // --- Hilos esperando respuesta: el último mensaje es del cliente ---
    // Las notas internas no cuentan: son apuntes del equipo, no una
    // respuesta — el cliente sigue esperando aunque el operador anote.
    const porContacto = new Map<string, Interaction[]>();
    for (const i of interacciones) {
      if (i.channel === 'note') continue;
      const lista = porContacto.get(i.contactId) ?? [];
      lista.push(i);
      porContacto.set(i.contactId, lista);
    }
    const nombreDe = new Map(contactos.map((c) => [c.id, c]));

    const esperando: WaitingThread[] = [];
    for (const [contactId, lista] of porContacto) {
      const ultimo = [...lista].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
      if (ultimo?.direction !== 'inbound') continue;
      const contacto = nombreDe.get(contactId);
      esperando.push({
        contactId,
        displayName: contacto?.displayName,
        phone: contacto?.phones[0],
        channel: ultimo.channel,
        summary: ultimo.summary,
        occurredAt: ultimo.occurredAt,
        waitingMin: Math.max(0, Math.round((Date.now() - new Date(ultimo.occurredAt).getTime()) / 60_000)),
      });
    }
    // Quien más lleva esperando, primero: es una cola de atención.
    esperando.sort((a, b) => b.waitingMin - a.waitingMin);

    // --- Métricas del día ---
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    // Solo interacciones con clientes: los apuntes internos no son tráfico.
    const deHoy = interacciones.filter((i) => i.channel !== 'note' && new Date(i.occurredAt) >= hoy);
    const conversacionesHoy = deHoy.length;

    // Sparkline: casillas por hora del día.
    const porHora = new Array<number>(24).fill(0);
    for (const i of deHoy) porHora[new Date(i.occurredAt).getHours()]++;

    // Tráfico por canal (histórico completo): alimenta el mapa de flujo.
    const porCanalMap = new Map<Channel, { total: number; inbound: number }>();
    for (const i of interacciones) {
      if (i.channel === 'note') continue;
      const acc = porCanalMap.get(i.channel) ?? { total: 0, inbound: 0 };
      acc.total++;
      if (i.direction === 'inbound') acc.inbound++;
      porCanalMap.set(i.channel, acc);
    }
    const porCanal = [...porCanalMap.entries()].map(([channel, v]) => ({ channel, ...v }));

    let promesasActivas = 0;
    for (const c of contactos) {
      const señales = await this.brain.getSignals(c.id);
      if (señales.some((s) => s.type === 'promise' && s.status === 'active')) promesasActivas++;
    }

    // --- Actividad reciente (cross-canal, con nombre) ---
    const actividad = [...interacciones]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 8)
      .map((i) => ({
        contactId: i.contactId,
        displayName: nombreDe.get(i.contactId)?.displayName,
        channel: i.channel,
        direction: i.direction,
        summary: i.summary,
        occurredAt: i.occurredAt,
        source: i.source,
      }));

    // Hilos al día = hilos totales con actividad menos los que esperan.
    const hilosAlDia = Math.max(0, porContacto.size - esperando.length);

    // --- Obreros en el panal (espejo local: fresco por el sync periódico) ---
    const asignadas = new Set(Object.values(routing));
    let activos = pearls.filter((p) => p.status === 1);
    let totalPearls = pearls.length;
    if (this.mock && !pearls.length) {
      // Modo demo sin espejo: enjambre de muestra para que el tablero viva.
      activos = [
        { id: 'mock_voz', name: 'Recepcionista (demo)', channel: 'voice', status: 1 },
        { id: 'mock_wa', name: 'Línea 100 WhatsApp (demo)', channel: 'whatsapp', status: 1 },
        { id: 'mock_sms', name: 'Línea 100 TEXT (demo)', channel: 'sms', status: 1 },
      ];
      totalPearls = 3;
    }
    return {
      obreros: {
        total: totalPearls,
        activos: activos.length,
        enElPanal: activos.map((p) => ({
          id: p.id,
          name: p.name ?? p.id,
          channel: p.channel,
          synced: counts.get(p.id)?.total ?? 0,
          asignada: asignadas.has(p.id) || undefined,
        })),
      },
      metricas: {
        contactos: contactos.length,
        conversacionesHoy,
        esperandoRespuesta: esperando.length,
        promesasActivas,
        hilosAlDia,
        maxEsperaMin: esperando[0]?.waitingMin ?? 0,
        porHora,
      },
      porCanal,
      enVivo,
      esperando: esperando.slice(0, 8),
      actividad,
      canales: {
        nlpearl: this.nlpearlOk,
        // Los agentes conversan por el canal de texto de NL Pearl; Gupshup
        // quedó únicamente para entregar los OTP del login.
        whatsappAgentes: await this.textChannel(),
        otp: this.integrations.whatsappProvider(),
        db: this.dbMode,
      },
    };
  }

  /**
   * Cuenta conversaciones abiertas AHORA en el WhatsApp de NL Pearl.
   *
   * Solo WhatsApp: es el único canal de texto en uso hoy (sin proveedor de
   * voz propio, ese canal queda fuera de este pulso). Sin Pearl asignada al
   * canal, o si la cuenta no está configurada, se devuelve `null` en vez de
   * `0` — la ausencia de dato no es lo mismo que "cero conversaciones".
   */
  private async enVivoAhora(pearlIdWhatsapp?: string): Promise<HiveStatus['enVivo']> {
    if (!pearlIdWhatsapp || !this.nlpearlOk) return null;

    if (this.enVivoCache && Date.now() - this.enVivoCache.at < HiveService.EN_VIVO_TTL_MS) {
      return this.enVivoCache.value;
    }

    const valor = await this.client
      .getOngoingCalls(pearlIdWhatsapp)
      .then((r) => ({ total: r.totalOngoingCalls, enCola: r.totalOnQueue }))
      .catch(() => null);

    this.enVivoCache = { value: valor, at: Date.now() };
    return valor;
  }

  private async textChannel(): Promise<string | null> {
    if (this.textChannelCache && Date.now() - this.textChannelCache.at < 60_000) {
      return this.textChannelCache.value;
    }
    const value = this.nlpearlOk
      ? await this.client
          .getTextChannels()
          .then((c) => c[0]?.displayName ?? null)
          .catch(() => null)
      : null;
    this.textChannelCache = { value, at: Date.now() };
    return value;
  }
}
