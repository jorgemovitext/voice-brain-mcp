import { Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { UnifiedContext } from '../brain/types';
import { HubspotClient } from '../hubspot/hubspot.client';
import { NlpearlActivityStore, StoredActivity } from './activity.store';
import { ResumenService } from './resumen.service';

/** Etiquetas legibles de los pasos del flujo, para redactar el resumen. */
const CAMPO: Record<string, string> = {
  tipoProblema: 'Problema',
  tipoConsulta: 'Consulta',
  ubicacion: 'Ubicación',
  descripcion: 'Detalle',
  nombreCiudadano: 'Nombre',
  contactoCiudadano: 'Contacto',
};

export interface Expediente {
  /**
   * Resumen de lo conversado. Prioriza el que redacta el propio agente
   * (`post_call_summary`), y si no existe se compone con lo que el flujo
   * recopiló. Nunca es "el último mensaje": eso no resume nada.
   */
  resumen: {
    texto: string | null;
    /**
     * `propio` = lo redactamos nosotros desde la transcripción (lo preferido).
     * `agente` = el post_call_summary crudo de NL Pearl, respaldo cuando no
     * hay modelo configurado. `datos` = compuesto con lo que el flujo capturó.
     */
    fuente: 'propio' | 'agente' | 'datos' | null;
    /** Datos capturados, para mostrarlos como ficha bajo el resumen. */
    capturado: Array<{ campo: string; valor: string }>;
  };
  /**
   * Caso real del CRM. Sin HubSpot conectado o sin ticket para ese teléfono,
   * se dice — antes esta tarjeta mostraba "Seguimiento general / Abierto"
   * fijo, que no cambiaba nunca porque no miraba nada.
   */
  caso: {
    hay: boolean;
    motivo?: string;
    id?: string;
    asunto?: string;
    etapa?: string;
    cerrado?: boolean;
    creado?: string;
    actualizado?: string;
  };
}

@Injectable()
export class ExpedienteService {
  private readonly logger = new Logger(ExpedienteService.name);

  constructor(
    private readonly brain: BrainService,
    private readonly store: NlpearlActivityStore,
    private readonly hubspot: HubspotClient,
    private readonly ia: ResumenService,
  ) {}

  private static digitos(t?: string): string {
    return (t ?? '').replace(/\D/g, '');
  }

  /**
   * Una oración y nunca más de 160 caracteres — el mismo tope que el resumen
   * generado, para que la tarjeta mida igual venga de donde venga. Es el
   * respaldo: el resumen bueno lo redacta el modelo, pero cuando no está
   * configurado tampoco se vuelca el párrafo entero de NL Pearl.
   */
  private static recorte(texto: string, tope = 160): string {
    const limpio = texto.replace(/\s+/g, ' ').trim();
    const primera = limpio.match(/^[^.!?]+[.!?]/)?.[0]?.trim() ?? limpio;
    if (primera.length <= tope) return primera;
    const corte = primera.slice(0, tope);
    return `${corte.slice(0, corte.lastIndexOf(' ') || tope)}…`;
  }

  async de(contactId: string): Promise<Expediente> {
    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    const [resumen, caso] = await Promise.all([this.resumen(ctx, tel), this.caso(tel)]);
    return { resumen, caso };
  }

  /**
   * Id de la conversación a la que pertenece cada actividad. Los avances lo
   * llevan dentro del raw; las conversaciones SON ese id.
   */
  private static conversacionDe(a: StoredActivity): string | undefined {
    if (a.kind === 'progress') {
      return ((a.raw ?? {}) as { conversationId?: string }).conversationId;
    }
    return a.id;
  }

  private async resumen(ctx: UnifiedContext, tel?: string): Promise<Expediente['resumen']> {
    if (!tel) return { texto: null, fuente: null, capturado: [] };

    const actividad = await this.store.listActivity({ phone: tel, limit: 40 });

    /*
     * Todo el expediente se arma sobre UNA conversación: la más reciente.
     *
     * Antes se mezclaba todo lo del teléfono, y como el mismo número puede
     * reportar varias veces, la ficha terminaba siendo la fusión de varios
     * casos mientras el resumen salía de otro. Se veía el resumen de un
     * reporte de ruido junto a los datos de un vehículo abandonado: dos
     * ciudadanos distintos en la misma tarjeta.
     */
    const porConversacion = new Map<string, StoredActivity[]>();
    for (const a of actividad) {
      const id = ExpedienteService.conversacionDe(a);
      if (!id) continue;
      const grupo = porConversacion.get(id) ?? [];
      grupo.push(a);
      porConversacion.set(id, grupo);
    }

    const reciente = [...porConversacion.entries()]
      .map(([id, items]) => ({
        id,
        items,
        cuando: items.reduce((max, i) => ((i.occurredAt ?? '') > max ? i.occurredAt ?? '' : max), ''),
      }))
      .sort((a, b) => b.cuando.localeCompare(a.cuando))[0];

    const delCaso = reciente?.items ?? [];

    // Lo que el flujo recopiló EN ESA conversación; gana el valor más nuevo.
    const capturado = new Map<string, string>();
    for (const a of [...delCaso].sort((x, y) => (x.occurredAt ?? '').localeCompare(y.occurredAt ?? ''))) {
      if (a.kind !== 'progress') continue;
      const datos = ((a.raw ?? {}) as { datos?: Record<string, unknown> }).datos ?? {};
      for (const [k, v] of Object.entries(datos)) {
        if (typeof v === 'string' && v.trim()) capturado.set(k, v.trim());
      }
    }

    const ficha = [...capturado.entries()].map(([campo, valor]) => ({
      campo: CAMPO[campo] ?? campo,
      valor,
    }));

    /*
     * La transcripción se toma de las interacciones del Brain, no del raw de
     * NL Pearl: ahí ya está aplanada a "Agente: …\nCliente: …" por el mapper,
     * que es el único que sabe interpretar el enum numérico de `role`. Se
     * limita a la misma conversación por el esquema de id `nlpearl:<id>`.
     */
    const deEsteCaso = reciente
      ? ctx.recentInteractions.filter((i) => i.id.startsWith(`nlpearl:${reciente.id}`))
      : [];
    const transcripcion = (deEsteCaso.length ? deEsteCaso : ctx.recentInteractions)
      .filter((i) => i.transcript?.trim())
      .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))[0]?.transcript;

    /*
     * Primero, el resumen propio: el `post_call_summary` de NL Pearl viene
     * largo, en inglés y narrado por el bot ("I collected his details…"), que
     * es justo lo que el operador NO necesita leer.
     */
    if (transcripcion) {
      const propio = await this.ia.corto(transcripcion, tel);
      if (propio) return { texto: propio, fuente: 'propio', capturado: ficha };
    }

    // Respaldo: el crudo del agente, RECORTADO. Sin modelo configurado no se
    // puede resumir de verdad, pero tampoco se vuelca un párrafo entero.
    const conResumen = delCaso
      .filter((a) => a.kind === 'call' || a.kind === 'chat')
      .map((a) => (a.raw ?? {}) as Record<string, unknown>)
      .map((raw) => raw['summary'] ?? raw['post_call_summary'])
      .find((s): s is string => typeof s === 'string' && s.trim().length > 10);

    if (conResumen) {
      return { texto: ExpedienteService.recorte(conResumen), fuente: 'agente', capturado: ficha };
    }

    // Sin resumen del agente, se redacta uno con los datos duros.
    const problema = capturado.get('tipoProblema') ?? capturado.get('tipoConsulta');
    if (problema) {
      const donde = capturado.get('ubicacion');
      const detalle = capturado.get('descripcion');
      const partes = [
        `Reportó ${problema.toLowerCase()}`,
        donde ? `en ${donde}` : null,
      ].filter(Boolean);
      return {
        texto: `${partes.join(' ')}.${detalle ? ` ${detalle}` : ''}`,
        fuente: 'datos',
        capturado: ficha,
      };
    }

    return { texto: null, fuente: null, capturado: ficha };
  }

  private async caso(tel?: string): Promise<Expediente['caso']> {
    if (!this.hubspot.configured) return { hay: false, motivo: 'CRM sin conectar' };
    if (!tel) return { hay: false, motivo: 'El contacto no tiene teléfono' };

    try {
      /*
       * Por asociación, no por una propiedad del ticket: el objeto ticket de
       * HubSpot no guarda teléfono. Se busca el contacto por su número y se
       * siguen sus tickets. El barrido por `phone` queda de respaldo, por si
       * el portal definió esa propiedad a medida.
       */
      const [asociados, etapas] = await Promise.all([
        this.hubspot.ticketsPorTelefono(tel),
        this.hubspot.etapas(),
      ]);

      let candidatos = asociados;
      if (!candidatos.length) {
        const buscado = ExpedienteService.digitos(tel);
        const { tickets } = await this.hubspot.listarTickets();
        candidatos = tickets.filter((t) => t.phone && ExpedienteService.digitos(t.phone) === buscado);
      }

      // El más reciente de ese teléfono: es el caso "actual".
      const ticket = [...candidatos].sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      )[0];

      if (!ticket) {
        return { hay: false, motivo: 'Sin ticket en el CRM para este número' };
      }

      const etapa = ticket.stage ? etapas.get(ticket.stage) : undefined;
      return {
        hay: true,
        id: ticket.id,
        asunto: ticket.subject,
        etapa: etapa?.label ?? ticket.stage,
        cerrado: etapa?.isClosed ?? false,
        creado: ticket.createdAt,
        actualizado: ticket.updatedAt,
      };
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`No se pudo leer el caso: ${motivo}`);
      return { hay: false, motivo };
    }
  }
}
