import { Injectable } from '@nestjs/common';
import { NlpearlActivityStore } from './activity.store';

/**
 * Una acción que el operador humano debería ejecutar ahora.
 *
 * `urgente` es lo que hace que la pill lata en la consola: no es decoración,
 * marca el momento en que el flujo del agente habría escalado solo.
 */
export interface AccionSugerida {
  id: string;
  etiqueta: string;
  /** Por qué se sugiere: el operador tiene que poder discrepar con criterio. */
  motivo: string;
  tipo: 'hubspot' | 'aviso' | 'dato';
  urgente: boolean;
}

/** Los datos que el flujo necesita antes de poder registrar un reporte. */
const REQUERIDOS = ['tipoProblema', 'ubicacion', 'descripcion'] as const;

@Injectable()
export class AccionesService {
  constructor(private readonly store: NlpearlActivityStore) {}

  /**
   * Qué le toca hacer al humano en este punto de la conversación.
   *
   * Sale de la MISMA lógica que sigue el agente en su flujo: los avances
   * dicen qué datos ya recopiló y cuáles faltan, y el estado del CRM dice si
   * el reporte ya quedó registrado. Cuando el operador toma el hilo, el
   * agente deja de cerrarlo — estas acciones son justamente lo que el flujo
   * habría hecho solo y ahora queda en manos de la persona.
   */
  async de(
    telefono: string | undefined,
    caso: { hay: boolean },
  ): Promise<AccionSugerida[]> {
    if (!telefono) return [];

    const avances = await this.store.listActivity({ phone: telefono, kind: 'progress', limit: 40 });
    if (!avances.length) return [];

    // Lo recopilado hasta ahora, y por qué nodos pasó la conversación.
    const capturado = new Map<string, string>();
    const pasos = new Set<string>();
    for (const a of avances) {
      const raw = (a.raw ?? {}) as { paso?: string; datos?: Record<string, unknown> };
      if (raw.paso) pasos.add(raw.paso);
      for (const [k, v] of Object.entries(raw.datos ?? {})) {
        if (typeof v === 'string' && v.trim()) capturado.set(k, v.trim());
      }
    }

    const acciones: AccionSugerida[] = [];

    // El flujo manda al 911 y avisa a un operador: eso no espera a nada más.
    if (pasos.has('emergency') || pasos.has('handoffEmergency')) {
      acciones.push({
        id: 'emergencia',
        etiqueta: 'Avisar a la cuadrilla de emergencia',
        motivo: 'El agente clasificó el caso como emergencia y transfirió a un operador.',
        tipo: 'aviso',
        urgente: true,
      });
    }

    const faltan = REQUERIDOS.filter((c) => !capturado.has(c));
    if (faltan.length) {
      acciones.push({
        id: 'faltan-datos',
        etiqueta: `Falta ${etiquetaDe(faltan[0])}`,
        motivo: `Sin ${faltan.map(etiquetaDe).join(', ')} el reporte no se puede registrar.`,
        tipo: 'dato',
        urgente: false,
      });
    } else if (!caso.hay) {
      // Todo lo necesario está y no hay ticket: es el momento exacto en que
      // el flujo lo habría creado.
      acciones.push({
        id: 'crear-ticket',
        etiqueta: 'Registrar el reporte en HubSpot',
        motivo: 'Ya están el problema, la ubicación y el detalle, pero no hay ticket en el CRM.',
        tipo: 'hubspot',
        urgente: true,
      });
    }

    if (!capturado.has('contactoCiudadano') && !capturado.has('nombreCiudadano')) {
      acciones.push({
        id: 'pedir-contacto',
        etiqueta: 'Pedir nombre y contacto',
        motivo: 'Sin datos de contacto no hay a quién darle seguimiento.',
        tipo: 'dato',
        urgente: false,
      });
    }

    return acciones;
  }
}

function etiquetaDe(campo: string): string {
  switch (campo) {
    case 'tipoProblema':
      return 'el tipo de problema';
    case 'ubicacion':
      return 'la ubicación';
    case 'descripcion':
      return 'la descripción';
    default:
      return campo;
  }
}
