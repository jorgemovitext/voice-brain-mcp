import { Channel } from '../brain/types';

/**
 * Puerto de canal de salida (WhatsApp / SMS propios — NO los canales
 * de texto de NL Pearl). Cada adaptador implementa `send`.
 */
export interface ChannelPort {
  readonly channel: Channel;
  send(contactId: string, message: string): Promise<{ delivered: boolean; providerId?: string }>;
}

/** Token de inyección para el adaptador WhatsApp. */
export const WHATSAPP_CHANNEL = 'ChannelPort:whatsapp';
/** Token de inyección para el adaptador SMS. */
export const SMS_CHANNEL = 'ChannelPort:sms';
