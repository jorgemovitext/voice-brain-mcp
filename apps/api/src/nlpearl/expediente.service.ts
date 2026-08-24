import { Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { NlpearlActivityStore } from './activity.store';

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
    fuente: 'agente' | 'datos' | null;
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
  ) {}

  private static digitos(t?: string): string {
    return (t ?? '').replace(/\D/g, '');
  }

  async de(contactId: string): Promise<Expediente> {
    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    const [resumen, caso] = await Promise.all([this.resumen(tel), this.caso(tel)]);
    return { resumen, caso };
  }

  private async resumen(tel?: string): Promise<Expediente['resumen']> {
    if (!tel) return { texto: null, fuente: null, capturado: [] };

    const actividad = await this.store.listActivity({ phone: tel, limit: 20 });

    // Lo que el flujo recopiló: se queda el valor más reciente de cada campo.
    const capturado = new Map<string, string>();
    for (const a of [...actividad].sort((x, y) => (x.occurredAt ?? '').localeCompare(y.occurredAt ?? ''))) {
      if (a.kind !== 'progress') continue;
      const datos = ((a.raw ?? {}) as { datos?: Record<string, unknown> }).datos ?? {};
      for (const [k, v] of Object.entries(datos)) {
        if (typeof v === 'string' && v.trim()) capturado.set(k, v.trim());
      }
    }

    // El resumen del agente vive en el raw de la conversación.
    const conResumen = actividad
      .filter((a) => a.kind !== 'progress')
      .map((a) => (a.raw ?? {}) as Record<string, unknown>)
      .map((raw) => raw['summary'] ?? raw['post_call_summary'])
      .find((s): s is string => typeof s === 'string' && s.trim().length > 10);

    const ficha = [...capturado.entries()].map(([campo, valor]) => ({
      campo: CAMPO[campo] ?? campo,
      valor,
    }));

    if (conResumen) return { texto: conResumen.trim(), fuente: 'agente', capturado: ficha };

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
      const [{ tickets }, etapas] = await Promise.all([
        this.hubspot.listarTickets(),
        this.hubspot.etapas(),
      ]);
      const buscado = ExpedienteService.digitos(tel);
      // El más reciente de ese teléfono: es el caso "actual".
      const ticket = tickets
        .filter((t) => ExpedienteService.digitos(t.phone) === buscado)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];

      if (!ticket) return { hay: false, motivo: 'Sin ticket en el CRM para este número' };

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
