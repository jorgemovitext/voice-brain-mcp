import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { WebhookLogService } from '../shared/webhook-log.service';
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
    private readonly webhookLog: WebhookLogService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
    private readonly config: ConfigService,
  ) {}


  /** Las 24 h de WhatsApp: dentro de la ventana se puede escribir libre. */
  private static readonly VENTANA_MS = 24 * 60 * 60_000;

  /**
   * Presentación en texto libre, para cuando la ventana está abierta.
   *
   * Se anuncia el cambio de interlocutor sin romper el hilo: la persona venía
   * hablando con el agente y de golpe le contesta alguien más. Decir quién es
   * evita que parezca que el agente cambió de personalidad.
   */
  private async saludarLibre(contactId: string, operador: string): Promise<{ aviso?: string }> {
    const mensaje = `Hola, soy ${operador} y sigo yo esta conversación. Ya leí lo que escribiste.`;
    try {
      const envio = await this.whatsapp.send(contactId, mensaje);
      await this.brain.appendInteraction({
        contactId,
        channel: 'whatsapp',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: mensaje,
        source: 'own',
        handledBy: operador,
        collectedInfo: envio.providerId ? { providerId: envio.providerId } : undefined,
      });
      this.logger.log(`${operador} se presentó con ${contactId} en texto libre (ventana abierta)`);
      this.webhookLog.push(
        'saliente',
        `${operador} tomó el hilo y se presentó sin plantilla (la ventana de 24 h estaba abierta)`,
        true,
      );
      return {};
    } catch (err) {
      const motivo = `no se pudo enviar la presentación — ${(err as Error).message}`;
      this.webhookLog.push('saliente', `Saludo al tomar el hilo: ${motivo}`, false);
      return { aviso: motivo };
    }
  }

  /**
   * ¿Podemos escribirle libremente a este contacto?
   *
   * WhatsApp solo deja mandar texto libre dentro de las 24 h siguientes al
   * último mensaje de la persona; fuera de esa ventana hay que usar una
   * plantilla aprobada. La ventana la abre SU mensaje, así que la respuesta
   * está en el hilo: basta mirar cuándo fue el último entrante.
   */
  private async ventanaAbierta(contactId: string): Promise<boolean> {
    try {
      const interacciones = await this.brain.listInteractions(contactId);
      const ultimoEntrante = interacciones
        .filter((i) => i.direction === 'inbound' && i.channel === 'whatsapp')
        .reduce<string>((max, i) => (i.occurredAt > max ? i.occurredAt : max), '');
      if (!ultimoEntrante) return false;
      return Date.now() - new Date(ultimoEntrante).getTime() < EjecutarService.VENTANA_MS;
    } catch {
      // Ante la duda, plantilla: es la vía que funciona en los dos casos.
      return false;
    }
  }

  /**
   * Se presenta con el ciudadano al tomar el hilo.
   *
   * Por qué hay dos caminos: la plantilla es la única forma de INICIAR una
   * conversación, pero cuesta y suena enlatada. Desde que el agente atiende
   * sobre NUESTRO número, el ciudadano acaba de escribirnos y la ventana de
   * 24 h está abierta — ahí la plantilla sobra: se le cobra a la alcaldía y,
   * peor, corta la conversación con un saludo robótico a mitad de camino.
   *
   * Con NL Pearl esto no se podía elegir: el ciudadano escribía a SU número,
   * la ventana con nosotros nunca se abría y la plantilla era la única vía.
   * Ese caso sigue existiendo y por eso el camino de la plantilla se queda.
   *
   * No lanza: tomar el hilo no puede fallar porque el saludo no salga. El
   * motivo vuelve como `aviso` para mostrarlo en la consola.
   */
  async saludar(contactId: string, operador: string): Promise<{ aviso?: string }> {
    if (await this.ventanaAbierta(contactId)) return this.saludarLibre(contactId, operador);

    const gupshup = this.whatsapp as Partial<{
      templateSaludo: string;
      sendTemplate: (to: string, id: string, params: string[]) => Promise<unknown>;
    }>;

    // Cada salida deja rastro en la bitácora. Sin esto, un saludo que no sale
    // es indistinguible de un saludo que nunca se intentó.
    const fallo = (motivo: string) => {
      this.webhookLog.push('saliente', `Saludo al tomar el hilo: ${motivo}`, false);
      return { aviso: motivo };
    };

    if (typeof gupshup.sendTemplate !== 'function') {
      return fallo('el proveedor de WhatsApp activo no manda plantillas (revisá las credenciales de Gupshup).');
    }
    if (!gupshup.templateSaludo) {
      return fallo('falta GUPSHUP_TEMPLATE_SALUDO: sin el id de la plantilla no se puede iniciar la conversación.');
    }

    const ctx = await this.brain.getContext({ contactId });
    const tel = ctx.contact.phones?.[0];
    if (!tel) return fallo('el contacto no tiene teléfono.');

    try {
      const envio = (await gupshup.sendTemplate(tel, gupshup.templateSaludo, [operador])) as
        | { providerId?: string }
        | undefined;

      /*
       * Y queda EN EL HILO. Sin esto el saludo salía de verdad pero el chat
       * no mostraba nada, así que desde la consola era indistinguible de un
       * envío que falló — y el operador no tenía cómo saber qué se mandó en
       * su nombre. El cuerpo exacto lo guarda Meta, así que se registra lo
       * que sí sabemos: que se envió el saludo y de parte de quién.
       *
       * "Entregado a Gupshup" y no "recibido": Gupshup acusa `submitted` al
       * aceptarlo y el veredicto real llega después, por su webhook. El
       * `providerId` queda guardado para poder cruzarlo con ese acuse.
       */
      await this.brain.appendInteraction({
        contactId,
        channel: 'whatsapp',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: `Saludo de presentación enviado de parte de ${operador}.`,
        source: 'own',
        collectedInfo: envio?.providerId ? { providerId: envio.providerId } : undefined,
      });

      this.logger.log(`${operador} se presentó con ${contactId} por plantilla`);
      /*
       * Se nombra el número EMISOR, no solo el destino.
       *
       * El ciudadano tiene dos chats abiertos con nosotros: el de la línea
       * del agente, donde ocurrió la conversación, y el nuestro, de donde
       * sale esta plantilla. Solo lo que responda al segundo pasa por
       * Gupshup y llega acá. Sin decir cuál es, "respondí y no llegó" no se
       * puede distinguir de "respondiste en el otro chat".
       */
      const emisor = this.config.get<string>('GUPSHUP_SOURCE_NUMBER', '') || 'nuestro número';
      this.webhookLog.push(
        'saliente',
        `Saludo enviado a ${tel} desde ${emisor} de parte de ${operador} — solo lo que responda a ${emisor} llega a la app`,
        true,
      );
      return {};
    } catch (err) {
      return fallo(`Gupshup rechazó el saludo — ${(err as Error).message}`);
    }
  }

}
