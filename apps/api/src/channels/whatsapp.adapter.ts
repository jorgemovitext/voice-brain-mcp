import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '../brain/types';
import { ChannelPort } from '../ports/channel.port';

/**
 * Stub del canal WhatsApp propio. Hueco para conectar nuestra WABA
 * (WhatsApp Business API) — NO los canales de texto de NL Pearl.
 * Hoy: loguea el mensaje y responde "entregado".
 */
@Injectable()
export class WhatsappAdapter implements ChannelPort {
  readonly channel: Channel = 'whatsapp';
  private readonly logger = new Logger('WhatsApp');

  async send(contactId: string, message: string): Promise<{ delivered: boolean; providerId?: string }> {
    // TODO: integrar WABA propia (Cloud API): POST /messages con template/session
    this.logger.log(`→ [WhatsApp] a contacto ${contactId}: "${message}"`);
    return { delivered: true, providerId: `wa_${Date.now()}` };
  }
}
