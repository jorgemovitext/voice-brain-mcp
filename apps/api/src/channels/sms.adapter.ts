import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '../brain/types';
import { ChannelPort } from '../ports/channel.port';

/**
 * Stub del canal SMS propio (hueco para Twilio/Infobip/etc.).
 * Hoy: loguea el mensaje y responde "entregado".
 */
@Injectable()
export class SmsAdapter implements ChannelPort {
  readonly channel: Channel = 'sms';
  private readonly logger = new Logger('SMS');

  async send(contactId: string, message: string): Promise<{ delivered: boolean; providerId?: string }> {
    // TODO: integrar proveedor SMS real
    this.logger.log(`→ [SMS] a contacto ${contactId}: "${message}"`);
    return { delivered: true, providerId: `sms_${Date.now()}` };
  }
}
