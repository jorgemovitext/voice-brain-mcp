import { Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { Interaction } from '../brain/types';
import { AgenteToolsService } from './agente-tools.service';
import { ElevenLabsClient } from './elevenlabs.client';

/**
 * El agente de ElevenLabs atendiendo sobre NUESTRO canal.
 *
 * Su trabajo es el que el cliente no hace: traducir un hilo del Brain a algo
 * que el agente pueda leer. Como cada turno abre una conexión nueva (ver
 * `ElevenLabsClient`), el agente llega sin memoria y es esta clase la que se
 * la presta.
 *
 * Que la memoria viva de nuestro lado no es un parche: es lo que permite que
 * el mismo hilo pase por voz, por WhatsApp o por un humano sin reiniciarse.
 * Con NL Pearl el contexto vivía en su plataforma y por eso cada canal era
 * una isla.
 */
@Injectable()
export class ElevenLabsService {
  private readonly logger = new Logger(ElevenLabsService.name);

  /** Cuántos turnos previos se le recuerdan al agente. */
  private static readonly TURNOS = 12;

  constructor(
    private readonly brain: BrainService,
    private readonly client: ElevenLabsClient,
    private readonly tools: AgenteToolsService,
  ) {}

  configurado(): boolean {
    return this.client.configurado();
  }

  /**
   * Contesta un mensaje del ciudadano en nombre del hilo.
   *
   * Devuelve null si el motor está apagado o no contestó; quien llama decide
   * qué hacer con ese silencio.
   */
  async responderEnHilo(contactId: string, texto: string): Promise<string | null> {
    if (!this.configurado()) return null;

    const ctx = await this.brain.getContext({ contactId }).catch(() => null);
    const historial = ElevenLabsService.historial(ctx?.recentInteractions ?? []);
    const nombre = ctx?.contact.displayName?.trim();

    const r = await this.client.responder({
      texto,
      contexto: historial,
      // El prompt del agente puede interpolarlas como {{nombre_ciudadano}}.
      variables: {
        nombre_ciudadano: nombre || 'sin nombre registrado',
        telefono: ctx?.contact.phones?.[0] ?? '',
      },
      /*
       * Lo que el agente puede HACER, no solo decir: abrir el ticket en el
       * CRM y avisarle a la cuadrilla. Se ejecuta contra ESTE hilo, así que
       * el contactId va cerrado en el closure y el agente no puede pedir
       * acciones sobre la conversación de otra persona.
       */
      ejecutarHerramienta: (herramienta, args) => this.tools.ejecutar(contactId, herramienta, args),
    });

    if (!r) return null;
    this.logger.log(`El agente contestó a ${nombre ?? contactId}: "${ElevenLabsService.corto(r.texto)}"`);
    return r.texto;
  }

  /**
   * El hilo en texto plano, del más viejo al más nuevo.
   *
   * Se recorta a los últimos turnos porque el historial entero de un vecino
   * que reporta seguido no aporta y sí encarece: cada turno se manda de nuevo
   * en cada mensaje, así que lo que se agrega acá se paga en todos los turnos
   * siguientes.
   */
  private static historial(interacciones: Interaction[]): string {
    const utiles = interacciones
      .filter((i) => i.channel !== 'note' && (i.summary ?? '').trim())
      .slice(-ElevenLabsService.TURNOS);

    if (!utiles.length) return '';

    const lineas = utiles.map((i) => {
      const quien = i.direction === 'inbound' ? 'Ciudadano' : 'Nosotros';
      return `${quien}: ${(i.summary ?? '').trim()}`;
    });

    return [
      'Conversación previa con esta persona, del mensaje más viejo al más nuevo.',
      'Es contexto para que respondas con continuidad; no lo repitas ni lo comentes.',
      '',
      ...lineas,
    ].join('\n');
  }

  /** Para el log: la respuesta entera ensucia sin agregar nada. */
  private static corto(texto: string, tope = 80): string {
    const limpio = texto.replace(/\s+/g, ' ').trim();
    return limpio.length <= tope ? limpio : `${limpio.slice(0, tope)}…`;
  }
}
