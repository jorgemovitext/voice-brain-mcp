import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { NlpearlActivityStore } from './activity.store';

/**
 * Números de la coordinación de emergencia (CODEM, Infraestructura, Movilidad
 * y Orden Público comparten este canal). Es el mismo destino que usa el
 * escalamiento automático, para que el aviso manual llegue al mismo lugar.
 */
const CUADRILLA = '+50498288272';

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
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
  ) {}

  /**
   * Avisa a la cuadrilla de emergencia por WhatsApp con lo que el flujo
   * alcanzó a recopilar.
   *
   * Antes esta acción era solo una etiqueta: se le pedía al operador "avisá a
   * la cuadrilla" y la app no ofrecía ninguna forma de hacerlo. En una
   * emergencia, mandar a alguien a buscar el número en otro lado es
   * exactamente el minuto que no sobra.
   */
  async avisarCuadrilla(contactId: string, operador: string): Promise<{ aviso?: string }> {
    const { tel, datos } = await this.datosDelCaso(contactId);

    const mensaje = [
      '🚨 Línea 100 · emergencia',
      datos.get('tipoProblema') ?? datos.get('tipoConsulta') ?? 'Reporte ciudadano',
      datos.get('ubicacion') ? `Ubicación: ${datos.get('ubicacion')}` : null,
      datos.get('direccionFormateada') ? `Referencia: ${datos.get('direccionFormateada')}` : null,
      datos.get('descripcion') ? `Detalle: ${datos.get('descripcion')}` : null,
      datos.get('obstruye_paso') === 'sí' ? 'Obstruye el paso.' : null,
      `Reporta: ${datos.get('nombreCiudadano') ?? 'ciudadano'} (${tel})`,
      `Avisa: ${operador}, desde la consola.`,
    ]
      .filter(Boolean)
      .join('\n');

    const { contactId: destino } = await this.brain.resolveIdentity({
      phone: CUADRILLA,
      system: 'sender',
    });
    await this.whatsapp.send(destino, mensaje);

    this.logger.log(`${operador} avisó a la cuadrilla por ${contactId}`);
    return {};
  }

  /**
   * Se presenta con el ciudadano al tomar el hilo.
   *
   * El ciudadano le escribió al número de NL Pearl, no al nuestro, así que la
   * ventana de 24 h nunca se abrió con nosotros y el texto libre no sale. La
   * plantilla aprobada es lo único que puede iniciar, y además su respuesta
   * es la que abre la ventana para poder conversar de verdad.
   *
   * No lanza: tomar el hilo no puede fallar porque el saludo no salga. El
   * motivo vuelve como `aviso` para mostrarlo en la consola.
   */
  async saludar(contactId: string, operador: string): Promise<{ aviso?: string }> {
    const gupshup = this.whatsapp as Partial<{
      templateSaludo: string;
      sendTemplate: (to: string, id: string, params: string[]) => Promise<unknown>;
    }>;
    if (typeof gupshup.sendTemplate !== 'function' || !gupshup.templateSaludo) {
      return { aviso: 'Sin plantilla configurada no se le pudo escribir al ciudadano.' };
    }

    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    if (!tel) return { aviso: 'El contacto no tiene teléfono: no se envió el saludo.' };

    try {
      await gupshup.sendTemplate(tel, gupshup.templateSaludo, [operador]);
      this.logger.log(`${operador} se presentó con ${contactId} por plantilla`);
      return {};
    } catch (err) {
      return { aviso: `No se pudo enviar el saludo: ${(err as Error).message}` };
    }
  }

  /** Teléfono del ciudadano y todo lo que el flujo capturó, en un solo lugar. */
  private async datosDelCaso(contactId: string): Promise<{ tel: string; datos: Map<string, string> }> {
    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    if (!tel) throw new BadRequestException('El contacto no tiene teléfono');

    const datos = new Map<string, string>();
    const avances = await this.store.listActivity({ phone: tel, kind: 'progress', limit: 40 });
    for (const a of avances) {
      const raw = (a.raw ?? {}) as { datos?: Record<string, unknown> };
      for (const [k, v] of Object.entries(raw.datos ?? {})) {
        if (typeof v === 'string' && v.trim()) datos.set(k, v.trim());
      }
    }
    return { tel, datos };
  }

  async crearTicket(contactId: string, operador: string): Promise<{ id: string; aviso?: string }> {
    if (!this.hubspot.configured) {
      throw new BadRequestException('HubSpot no está conectado: falta HUBSPOT_TOKEN');
    }

    // Lo que el flujo alcanzó a recopilar es exactamente lo que va al ticket.
    const { tel, datos } = await this.datosDelCaso(contactId);

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
