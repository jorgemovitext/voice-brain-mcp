import { Inject, Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';

/** Lo que se le devuelve al agente para que siga la conversación. */
export interface ResultadoHerramienta {
  ok: boolean;
  /** Texto corto que el agente puede leerle al ciudadano (el folio, el error). */
  mensaje: string;
}

/**
 * Lo que el agente PUEDE HACER, además de conversar.
 *
 * Son las herramientas que declara en ElevenLabs: cuando decide usarlas, nos
 * llega un `client_tool_call` por el WebSocket, se ejecutan acá y el
 * resultado vuelve para que el agente lo cuente.
 *
 * Cada ejecución deja una interacción en el hilo con `accion`, y ese es el
 * punto: el operador ve EN EL CHAT, entre los mensajes, que el reporte de un
 * derrumbe abrió un ticket y disparó el aviso — y en qué momento de la
 * conversación pasó. Guardarlo en un log aparte lo volvería un registro que
 * nadie mira.
 *
 * Con NL Pearl estas acciones las disparaba su flujo contra `/notificar`;
 * ahora las decide el agente y las ejecutamos nosotros, que es lo que nos
 * deja cambiar de motor sin perder el CRM ni los avisos.
 */
@Injectable()
export class AgenteToolsService {
  private readonly logger = new Logger(AgenteToolsService.name);

  /**
   * A quién se le avisa. Es el mismo número que ya usaba el aviso de
   * emergencia del flujo de NL Pearl.
   */
  private static readonly CUADRILLA = '+50498288272';

  constructor(
    private readonly brain: BrainService,
    private readonly hubspot: HubspotClient,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
  ) {}

  /** Los nombres tal como hay que declararlos en el agente de ElevenLabs. */
  static readonly NOMBRES = ['registrar_reporte', 'avisar_autoridad'] as const;

  /**
   * Ejecuta la herramienta que pidió el agente.
   *
   * Nunca lanza: si algo falla, el agente recibe el motivo y puede decírselo
   * al ciudadano en vez de quedarse mudo. Un error del CRM no puede cortar la
   * conversación.
   */
  async ejecutar(
    contactId: string,
    nombre: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    try {
      switch (nombre) {
        case 'registrar_reporte':
          return await this.registrarReporte(contactId, args);
        case 'avisar_autoridad':
          return await this.avisarAutoridad(contactId, args);
        default:
          this.logger.warn(`El agente pidió una herramienta que no existe: "${nombre}"`);
          return { ok: false, mensaje: `No existe la herramienta "${nombre}".` };
      }
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`Falló la herramienta "${nombre}": ${motivo}`);
      await this.anotar(contactId, 'ticket', false, `No se pudo ejecutar "${nombre}": ${motivo}`);
      return { ok: false, mensaje: `No se pudo completar la acción: ${motivo}` };
    }
  }

  /** Abre el ticket en el CRM y devuelve el folio para que el agente lo diga. */
  private async registrarReporte(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const tipo = String(args['tipo_problema'] ?? '').trim();
    const ubicacion = String(args['ubicacion'] ?? '').trim();
    const descripcion = String(args['descripcion'] ?? '').trim();

    // El agente puede equivocarse y llamar sin los datos. Se le dice qué
    // falta para que lo pregunte, en vez de abrir un ticket inservible.
    const faltan = [
      !tipo && 'el tipo de problema',
      !ubicacion && 'la ubicación',
      !descripcion && 'la descripción',
    ].filter(Boolean) as string[];
    if (faltan.length) {
      return { ok: false, mensaje: `Todavía falta ${faltan.join(', ')}. Preguntalo antes de registrar.` };
    }

    if (!this.hubspot.configured) {
      await this.anotar(contactId, 'ticket', false, `${tipo} en ${ubicacion} — el CRM no está conectado`);
      return {
        ok: false,
        mensaje: 'El CRM no está conectado, así que no hay folio. Decile que su reporte quedó anotado igual.',
      };
    }

    const ctx = await this.brain.getContext({ contactId });
    const telefono = ctx.contact.phones?.[0];

    const { id } = await this.hubspot.crearTicket(
      {
        subject: `${tipo} · ${ubicacion}`,
        content: [descripcion, `Reporta: ${ctx.contact.displayName ?? 'ciudadano'} (${telefono ?? 's/n'})`]
          .filter(Boolean)
          .join('\n\n'),
      },
      telefono,
    );

    const folio = `AMDC-${id}`;
    await this.anotar(contactId, 'ticket', true, `${tipo} en ${ubicacion} · folio ${folio}`);
    this.logger.log(`El agente abrió el ticket ${folio} para ${contactId}`);

    return { ok: true, mensaje: `Reporte registrado con el folio ${folio}. Decíselo al ciudadano.` };
  }

  /**
   * Avisa a la cuadrilla por WhatsApp. Es el canal que tenemos a mano y que
   * ya se usaba para las emergencias del flujo anterior.
   */
  private async avisarAutoridad(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const motivo = String(args['motivo'] ?? '').trim();
    const ubicacion = String(args['ubicacion'] ?? '').trim();
    if (!motivo || !ubicacion) {
      return { ok: false, mensaje: 'Para avisar hace falta el motivo y la ubicación.' };
    }

    const ctx = await this.brain.getContext({ contactId });
    const texto = [
      '🚨 Línea 100 · aviso',
      motivo,
      `Ubicación: ${ubicacion}`,
      args['detalle'] ? `Detalle: ${String(args['detalle'])}` : null,
      `Reporta: ${ctx.contact.displayName ?? 'ciudadano'} (${ctx.contact.phones?.[0] ?? 's/n'})`,
      'Avisa: el agente de la Línea 100.',
    ]
      .filter(Boolean)
      .join('\n');

    const { contactId: destino } = await this.brain.resolveIdentity({
      phone: AgenteToolsService.CUADRILLA,
      displayName: 'Cuadrilla de emergencia',
    });
    await this.whatsapp.send(destino, texto);

    await this.anotar(contactId, 'aviso', true, `${motivo} en ${ubicacion} — avisado a la cuadrilla`);
    this.logger.log(`El agente avisó a la cuadrilla por ${contactId}: ${motivo}`);

    return { ok: true, mensaje: 'Ya se avisó a la cuadrilla. Decile al ciudadano que va en camino el aviso.' };
  }

  /**
   * Deja la acción EN EL HILO, no en un log aparte.
   *
   * `channel: 'note'` porque no es un mensaje que el ciudadano reciba, y
   * `accion` es lo que hace que la consola la dibuje como acción y no como
   * un apunte del equipo.
   */
  private async anotar(
    contactId: string,
    tipo: 'ticket' | 'aviso' | 'escalamiento',
    ok: boolean,
    detalle: string,
  ): Promise<void> {
    await this.brain
      .appendInteraction({
        contactId,
        channel: 'note',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: detalle,
        source: 'own',
        handledBy: 'agente',
        accion: { tipo, ok, detalle },
      })
      .catch((err) => {
        // La acción YA se hizo; no poder anotarla no la deshace.
        this.logger.warn(`No se pudo anotar la acción en el hilo: ${(err as Error).message}`);
      });
  }
}
