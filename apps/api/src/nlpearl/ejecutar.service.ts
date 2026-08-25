import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { NlpearlActivityStore } from './activity.store';

/**
 * Ejecuta, de parte del operador, las acciones que el flujo del agente habría
 * hecho solo. Es la contraparte de `AccionesService`: aquel dice QUÉ toca,
 * este lo hace.
 */
@Injectable()
export class EjecutarService {
  private readonly logger = new Logger(EjecutarService.name);

  constructor(
    private readonly brain: BrainService,
    private readonly store: NlpearlActivityStore,
    private readonly hubspot: HubspotClient,
  ) {}

  async crearTicket(contactId: string, operador: string): Promise<{ id: string; aviso?: string }> {
    if (!this.hubspot.configured) {
      throw new BadRequestException('HubSpot no está conectado: falta HUBSPOT_TOKEN');
    }

    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    if (!tel) throw new BadRequestException('El contacto no tiene teléfono');

    // Lo que el flujo alcanzó a recopilar es exactamente lo que va al ticket.
    const datos = new Map<string, string>();
    const avances = await this.store.listActivity({ phone: tel, kind: 'progress', limit: 40 });
    for (const a of avances) {
      const raw = (a.raw ?? {}) as { datos?: Record<string, unknown> };
      for (const [k, v] of Object.entries(raw.datos ?? {})) {
        if (typeof v === 'string' && v.trim()) datos.set(k, v.trim());
      }
    }

    const problema = datos.get('tipoProblema') ?? datos.get('tipoConsulta') ?? 'Reporte ciudadano';
    const ubicacion = datos.get('ubicacion');

    /*
     * `canal_reporte` va con la capitalización que espera el portal, pero no
     * se confía en eso: `crearTicket` sanea contra el esquema real y corrige
     * las diferencias de mayúsculas. Así, si mañana cambian las opciones, el
     * ticket se crea igual en vez de fallar entero.
     */
    const { id, descartadas } = await this.hubspot.crearTicket(
      {
        subject: ubicacion ? `${problema} - ${ubicacion}` : problema,
        content: [
          datos.get('descripcion'),
          ubicacion ? `Ubicación: ${ubicacion}` : null,
          datos.get('nombreCiudadano') ? `Ciudadano: ${datos.get('nombreCiudadano')}` : null,
          datos.get('contactoCiudadano') ? `Contacto: ${datos.get('contactoCiudadano')}` : null,
          `Registrado por ${operador} desde la consola.`,
        ]
          .filter(Boolean)
          .join('\n'),
        hs_pipeline: '0',
        hs_pipeline_stage: '1',
        canal_reporte: 'Whatsapp',
      },
      tel,
    );

    this.logger.log(`${operador} creó el ticket ${id} para ${contactId}`);
    return {
      id,
      aviso: descartadas.length
        ? `El ticket se creó, pero el portal no aceptó: ${descartadas.join(', ')}`
        : undefined,
    };
  }
}
