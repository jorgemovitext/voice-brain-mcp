import { Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { Channel, Interaction } from '../brain/types';
import { HubspotClient } from '../hubspot/hubspot.client';
import { NlpearlActivityStore } from './activity.store';

/** Un conteo con etiqueta, para rankings. */
export interface Conteo {
  etiqueta: string;
  total: number;
}

export interface Analytics {
  rango: { desde: string; hasta: string; dias: number; canal?: Channel };
  resumen: {
    conversaciones: number;
    mensajes: number;
    contactos: number;
    /** Hilos cuyo último mensaje lo puso el ciudadano: nadie contestó. */
    sinRespuesta: number;
    atendidos: number;
    /** Medianas, no promedios: un hilo olvidado de 3 días no debe torcer el número. */
    primeraRespuestaMin: number | null;
    duracionMin: number | null;
  };
  porDia: Array<{ dia: string; conversaciones: number; mensajes: number }>;
  /** 24 casillas: a qué hora escribe la gente. */
  porHora: number[];
  porCanal: Array<{ channel: Channel; total: number; inbound: number; outbound: number }>;
  agentes: Array<{ nombre: string; conversaciones: number; mensajes: number; ultima?: string }>;
  problemas: Conteo[];
  ubicaciones: Conteo[];
  sentimiento: { positive: number; neutral: number; negative: number; sinDato: number };
  casos: {
    configurado: boolean;
    motivo?: string;
    total?: number;
    cerrados?: number;
    enCurso?: number;
    porEtapa?: Array<{ etapa: string; total: number; cierraElCaso: boolean }>;
    resolucionHoras?: number | null;
    /** Conversaciones nuestras menos tickets: si no da ~0, algo no cuadra. */
    diferenciaConConversaciones?: number;
  };
  esperandoMas: Array<{
    contactId: string;
    displayName?: string;
    channel: Channel;
    esperaMin: number;
    resumen?: string;
  }>;
  /**
   * Aristas canal → problema → resultado, una por combinación, para el mapa
   * de flujo. El problema sale de los avances del flujo casados por teléfono
   * (dígitos): una conversación sin avance queda "Sin clasificar".
   */
  flujo: Array<{
    canal: Channel;
    problema: string;
    resultado: 'atendida' | 'esperando';
    total: number;
  }>;
}

/** Mediana: robusta ante los pocos hilos absurdamente largos que siempre hay. */
function mediana(valores: number[]): number | null {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : Math.round((orden[medio - 1] + orden[medio]) / 2);
}

function topN(conteos: Map<string, number>, n = 8): Conteo[] {
  return [...conteos.entries()]
    .map(([etiqueta, total]) => ({ etiqueta, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/**
 * El panel de fondo: lo que se atiende, cómo y con qué resultado.
 *
 * Todo sale de nuestra base salvo el ciclo de vida del caso, que vive en
 * HubSpot. Si el token no está, el resto igual se calcula y la sección de
 * casos dice por qué falta — vale más un panel incompleto y honesto que uno
 * completo con números inventados.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly brain: BrainService,
    private readonly store: NlpearlActivityStore,
    private readonly hubspot: HubspotClient,
  ) {}

  /** `canal` filtra el tablero entero; sin él se cuenta todo el tráfico. */
  async resumen(dias = 14, canal?: Channel): Promise<Analytics> {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86_400_000);

    const [contactos, todas, avances] = await Promise.all([
      this.brain.listContacts(),
      this.brain.listInteractions(),
      this.store.listActivity({ kind: 'progress', limit: 500 }),
    ]);

    // Las notas internas son del equipo, no conversación: no cuentan como tráfico.
    const enRango = todas.filter(
      (i) => i.channel !== 'note' && new Date(i.occurredAt) >= desde && (!canal || i.channel === canal),
    );

    const porContacto = new Map<string, Interaction[]>();
    for (const i of enRango) {
      const lista = porContacto.get(i.contactId) ?? [];
      lista.push(i);
      porContacto.set(i.contactId, lista);
    }
    for (const lista of porContacto.values()) {
      lista.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    }

    // --- Tiempos, hilo por hilo ---
    const primeras: number[] = [];
    const duraciones: number[] = [];
    let sinRespuesta = 0;
    const esperandoMas: Analytics['esperandoMas'] = [];
    const ahora = hasta.getTime();

    for (const [contactId, lista] of porContacto) {
      const primerEntrante = lista.find((i) => i.direction === 'inbound');
      if (primerEntrante) {
        const respuesta = lista.find(
          (i) => i.direction === 'outbound' && i.occurredAt > primerEntrante.occurredAt,
        );
        if (respuesta) {
          primeras.push(
            Math.round(
              (new Date(respuesta.occurredAt).getTime() - new Date(primerEntrante.occurredAt).getTime()) / 60_000,
            ),
          );
        }
      }

      const ultimo = lista[lista.length - 1];
      const inicio = new Date(lista[0].occurredAt).getTime();
      duraciones.push(Math.round((new Date(ultimo.occurredAt).getTime() - inicio) / 60_000));

      if (ultimo.direction === 'inbound') {
        sinRespuesta++;
        const contacto = contactos.find((c) => c.id === contactId);
        esperandoMas.push({
          contactId,
          displayName: contacto?.displayName,
          channel: ultimo.channel,
          esperaMin: Math.round((ahora - new Date(ultimo.occurredAt).getTime()) / 60_000),
          resumen: ultimo.summary,
        });
      }
    }
    esperandoMas.sort((a, b) => b.esperaMin - a.esperaMin);

    // --- Series ---
    // Los cubos terminan HOY, no ayer: contando `dias` hacia adelante desde
    // `desde` el último quedaba fuera y el panel decía "hoy: 0" con actividad
    // reciente a la vista.
    const porDia = new Map<string, { mensajes: number; hilos: Set<string> }>();
    for (let d = dias - 1; d >= 0; d--) {
      const dia = new Date(hasta.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      porDia.set(dia, { mensajes: 0, hilos: new Set() });
    }
    const porHora = Array<number>(24).fill(0);
    const canales = new Map<Channel, { total: number; inbound: number; outbound: number }>();
    const agentes = new Map<string, { mensajes: number; hilos: Set<string>; ultima?: string }>();
    const sentimiento = { positive: 0, neutral: 0, negative: 0, sinDato: 0 };

    for (const i of enRango) {
      const fecha = new Date(i.occurredAt);
      const dia = fecha.toISOString().slice(0, 10);
      const celda = porDia.get(dia);
      if (celda) {
        celda.mensajes++;
        celda.hilos.add(i.contactId);
      }
      porHora[fecha.getHours()]++;

      const canal = canales.get(i.channel) ?? { total: 0, inbound: 0, outbound: 0 };
      canal.total++;
      if (i.direction === 'inbound') canal.inbound++;
      else canal.outbound++;
      canales.set(i.channel, canal);

      if (i.handledBy) {
        const a = agentes.get(i.handledBy) ?? { mensajes: 0, hilos: new Set<string>() };
        a.mensajes++;
        a.hilos.add(i.contactId);
        if (!a.ultima || i.occurredAt > a.ultima) a.ultima = i.occurredAt;
        agentes.set(i.handledBy, a);
      }

      if (i.sentiment) sentimiento[i.sentiment]++;
      else sentimiento.sinDato++;
    }

    // --- Rankings desde los avances del flujo ---
    const problemas = new Map<string, number>();
    const ubicaciones = new Map<string, number>();
    const digitos = (t?: string) => (t ?? '').replace(/\D/g, '');
    /** Último problema reportado por teléfono, para casar con la conversación. */
    const problemaPorTel = new Map<string, string>();
    for (const a of avances) {
      const datos = ((a.raw ?? {}) as { datos?: Record<string, unknown> }).datos ?? {};
      const problema = datos['tipoProblema'] ?? datos['tipoConsulta'];
      const lugar = datos['ubicacion'];
      if (typeof problema === 'string' && problema.trim()) {
        problemas.set(problema.trim(), (problemas.get(problema.trim()) ?? 0) + 1);
        problemaPorTel.set(digitos(a.phone), problema.trim());
      }
      if (typeof lugar === 'string' && lugar.trim()) {
        ubicaciones.set(lugar.trim(), (ubicaciones.get(lugar.trim()) ?? 0) + 1);
      }
    }

    /*
     * --- Aristas del mapa de flujo: canal → problema → resultado ---
     *
     * La unidad es (contacto, canal) y no el contacto.
     *
     * Se tomaba UN canal por contacto —el del primer mensaje entrante—, así
     * que un vecino que escribió por WhatsApp y además llamó contaba entero
     * como WhatsApp. Con "Todos los canales" el mapa mostraba una sola columna
     * y la voz no aparecía nunca, por más llamadas que hubiera: el canal que
     * llegó segundo desaparecía dentro del primero.
     */
    const aristas = new Map<string, Analytics['flujo'][number]>();
    for (const [contactId, lista] of porContacto) {
      const tel = digitos(contactos.find((c) => c.id === contactId)?.phones?.[0]);
      const problema = problemaPorTel.get(tel) ?? 'Sin clasificar';

      const porCanal = new Map<Channel, Interaction[]>();
      for (const i of lista) porCanal.set(i.channel, [...(porCanal.get(i.channel) ?? []), i]);

      for (const [canal, turnos] of porCanal) {
        // "En espera" es del canal, no del contacto: se le puede haber
        // contestado el WhatsApp y tener la llamada sin devolver.
        const resultado =
          turnos[turnos.length - 1].direction === 'inbound' ? ('esperando' as const) : ('atendida' as const);
        const clave = `${canal}|${problema}|${resultado}`;
        const e = aristas.get(clave) ?? { canal, problema, resultado, total: 0 };
        e.total++;
        aristas.set(clave, e);
      }
    }

    return {
      rango: { desde: desde.toISOString(), hasta: hasta.toISOString(), dias, canal },
      resumen: {
        conversaciones: porContacto.size,
        mensajes: enRango.length,
        contactos: contactos.length,
        sinRespuesta,
        atendidos: porContacto.size - sinRespuesta,
        primeraRespuestaMin: mediana(primeras),
        duracionMin: mediana(duraciones),
      },
      porDia: [...porDia.entries()].map(([dia, v]) => ({
        dia,
        conversaciones: v.hilos.size,
        mensajes: v.mensajes,
      })),
      porHora,
      porCanal: [...canales.entries()]
        .map(([channel, v]) => ({ channel, ...v }))
        .sort((a, b) => b.total - a.total),
      agentes: [...agentes.entries()]
        .map(([nombre, v]) => ({ nombre, conversaciones: v.hilos.size, mensajes: v.mensajes, ultima: v.ultima }))
        .sort((a, b) => b.mensajes - a.mensajes),
      problemas: topN(problemas),
      ubicaciones: topN(ubicaciones),
      sentimiento,
      casos: await this.casos(porContacto.size),
      esperandoMas: esperandoMas.slice(0, 8),
      flujo: [...aristas.values()],
    };
  }

  /** Ciclo de vida del caso, desde HubSpot. Sin token, se dice y ya. */
  private async casos(conversaciones: number): Promise<Analytics['casos']> {
    if (!this.hubspot.configured) {
      return { configurado: false, motivo: 'Falta HUBSPOT_TOKEN' };
    }
    try {
      const [{ tickets }, etapas] = await Promise.all([
        this.hubspot.listarTickets(),
        this.hubspot.etapas(),
      ]);

      const porEtapa = new Map<string, { etapa: string; total: number; cierraElCaso: boolean }>();
      const resoluciones: number[] = [];
      let cerrados = 0;

      for (const t of tickets) {
        const info = t.stage ? etapas.get(t.stage) : undefined;
        const clave = info?.label ?? t.stage ?? 'sin etapa';
        const cierra = info?.isClosed ?? false;
        if (cierra) cerrados++;
        const actual = porEtapa.get(clave) ?? { etapa: clave, total: 0, cierraElCaso: cierra };
        actual.total++;
        porEtapa.set(clave, actual);

        if (t.createdAt && t.closedAt) {
          resoluciones.push(
            (new Date(t.closedAt).getTime() - new Date(t.createdAt).getTime()) / 3_600_000,
          );
        }
      }

      const horas = mediana(resoluciones.map((h) => Math.round(h * 10)));
      return {
        configurado: true,
        total: tickets.length,
        cerrados,
        enCurso: tickets.length - cerrados,
        porEtapa: [...porEtapa.values()].sort((a, b) => b.total - a.total),
        resolucionHoras: horas === null ? null : horas / 10,
        diferenciaConConversaciones: conversaciones - tickets.length,
      };
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`No se pudo leer HubSpot: ${motivo}`);
      return { configurado: false, motivo };
    }
  }
}
