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
  };
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
    whatsapp: string;
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

  constructor(
    private readonly brain: BrainService,
    private readonly store: NlpearlActivityStore,
    private readonly routing: PearlRoutingService,
    private readonly integrations: IntegrationsService,
    client: NlpearlClient,
    config: ConfigService,
  ) {
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

    // --- Hilos esperando respuesta: el último mensaje es del cliente ---
    const porContacto = new Map<string, Interaction[]>();
    for (const i of interacciones) {
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
    const conversacionesHoy = interacciones.filter((i) => new Date(i.occurredAt) >= hoy).length;

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

    // --- Obreros en el panal (espejo local: fresco por el sync periódico) ---
    const asignadas = new Set(Object.values(routing));
    const activos = pearls.filter((p) => p.status === 1);
    return {
      obreros: {
        total: pearls.length,
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
      },
      esperando: esperando.slice(0, 8),
      actividad,
      canales: {
        nlpearl: this.nlpearlOk,
        whatsapp: this.integrations.whatsappProvider(),
        db: this.dbMode,
      },
    };
  }
}
