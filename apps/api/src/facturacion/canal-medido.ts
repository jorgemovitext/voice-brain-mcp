import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { Channel } from '../brain/types';
import { ChannelPort, IntencionEnvio } from '../ports/channel.port';
import { orgActual } from '../shared/contexto-org';
import { LimitesService } from './limites.service';
import { MedicionService } from './medicion.service';

/**
 * El canal, medido.
 *
 * Envuelve al adaptador real —Gupshup, la Cloud API, el stub— y hace tres
 * cosas alrededor de cada envío: revisa el tope, manda, y lo anota para
 * cobrarlo.
 *
 * Está hecho como ENVOLTORIO y no como una llamada en cada lugar que manda
 * un mensaje porque hoy hay siete, mañana ocho, y la que se olvide es un
 * mensaje que sale sin cobrar. Un cobro que depende de que nadie se olvide
 * no es un cobro: es una estimación. Acá no hay forma de saltearse la
 * medición sin saltearse el canal.
 *
 * El orden importa: primero el tope, después el envío, al final la
 * anotación. Medir antes de mandar cobraría mensajes que el proveedor
 * rechazó.
 */
export class CanalMedido implements ChannelPort {
  private readonly logger = new Logger('CanalMedido');

  constructor(
    private readonly real: ChannelPort,
    private readonly medicion: MedicionService,
    private readonly limites: LimitesService,
    private readonly brain: BrainService,
  ) {}

  get channel(): Channel {
    return this.real.channel;
  }

  async send(
    contactId: string,
    message: string,
    intencion: IntencionEnvio = {},
  ): Promise<{ delivered: boolean; providerId?: string }> {
    const org = orgActual();

    if (org) {
      const veredicto = await this.limites.puedeEnviar(org, intencion);
      if (!veredicto.ok) {
        /*
         * No se manda. Es la única vez que un tope frena un mensaje, y la
         * excepción lleva el motivo escrito para que el operador lo lea en
         * la consola en vez de ver «falló el envío».
         */
        this.logger.warn(`Envío frenado para ${org}: ${veredicto.motivo}`);
        throw new ServiceUnavailableException(veredicto.motivo);
      }
    }

    const envio = await this.real.send(contactId, message, intencion);

    /*
     * El teléfono se busca DESPUÉS de mandar y con red de seguridad: es solo
     * para saber a qué país se cobra, y una consulta fallida no puede
     * deshacer un mensaje que ya salió. Sin teléfono, la medición cobra la
     * tarifa del país sin identificar, que es la más alta — nunca gratis.
     */
    let destino: string | undefined;
    try {
      destino = (await this.brain.getContext({ contactId })).contact.phones[0];
    } catch (err) {
      this.logger.warn(`Sin teléfono para medir el mensaje a ${contactId}: ${(err as Error).message}`);
    }

    await this.medicion.registrar({
      organizacion: org,
      destino,
      contacto: contactId,
      agente: intencion.agente,
      canal: this.real.channel,
      categoria: intencion.categoria,
      motivo: intencion.motivo,
      referencia: envio.providerId,
    });

    return envio;
  }
}
