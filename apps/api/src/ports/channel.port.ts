import { Channel } from '../brain/types';

/**
 * Puerto de canal de salida (WhatsApp / SMS propios — NO los canales
 * de texto de NL Pearl). Cada adaptador implementa `send`.
 */
/**
 * Por qué sale este mensaje. Lo usa la medición para cobrarlo bien: una
 * respuesta dentro de la ventana de 24 h y un recordatorio de mañana no
 * cuestan lo mismo ni se frenan con los mismos topes.
 *
 * Es opcional y los adaptadores lo ignoran: el que mide es el envoltorio.
 * Sin esto, cada llamada a `send` habría que cambiarla para pasar el motivo,
 * y la que se olvidara quedaría cobrada como respuesta — el precio más bajo,
 * o sea el error que no se nota.
 */
export interface IntencionEnvio {
  motivo?: 'respuesta' | 'seguimiento' | 'operador' | 'plantilla' | 'traspaso';
  categoria?: 'servicio' | 'utilidad' | 'autenticacion' | 'marketing';
  /** Qué agente lo manda, para poder decir cuánto gasta cada uno. */
  agente?: string;
}

export interface ChannelPort {
  readonly channel: Channel;
  send(
    contactId: string,
    message: string,
    intencion?: IntencionEnvio,
  ): Promise<{ delivered: boolean; providerId?: string }>;
}

/** Token de inyección para el adaptador WhatsApp. */
export const WHATSAPP_CHANNEL = 'ChannelPort:whatsapp';
/** Token de inyección para el adaptador SMS. */
export const SMS_CHANNEL = 'ChannelPort:sms';
