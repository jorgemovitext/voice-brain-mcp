import { Channel, Sentiment } from './models';

/** Helpers de presentación compartidos por las vistas (español CENAM). */

/** Emoji del canal — usar SOLO dentro del contenido del chat. */
export function channelIcon(channel: Channel): string {
  switch (channel) {
    case 'voice': return '📞';
    case 'whatsapp': return '💬';
    case 'sms': return '✉️';
    case 'note': return '📝';
  }
}

/** Nombre de icono SVG del canal (para la interfaz; ver icon.ts). */
export function channelIconName(channel: Channel): 'phone' | 'chat' | 'mail' | 'note' {
  switch (channel) {
    case 'voice': return 'phone';
    case 'whatsapp': return 'chat';
    case 'sms': return 'mail';
    case 'note': return 'note';
  }
}

/**
 * Color por canal, validado con el checker de paletas del proyecto
 * (ΔE ≥ 8 entre pares sobre fondo oscuro). Único lugar donde vive: antes
 * estaba duplicado en tablero.ts e integrations.ts con los mismos valores.
 */
const COLOR_CANAL: Record<Channel, string> = {
  whatsapp: '#729B26',
  voice: '#2196CC',
  sms: '#D9532C',
  note: '#8A8F98',
};

export function channelColor(channel: Channel): string {
  return COLOR_CANAL[channel] ?? '#8A8F98';
}

export function channelLabel(channel: Channel): string {
  switch (channel) {
    case 'voice': return 'Voz';
    case 'whatsapp': return 'WhatsApp';
    case 'sms': return 'SMS';
    case 'note': return 'Nota interna';
  }
}

export function sentimentLabel(sentiment?: Sentiment): string {
  switch (sentiment) {
    case 'positive': return 'Positivo';
    case 'negative': return 'Negativo';
    case 'neutral': return 'Neutral';
    default: return '—';
  }
}

/** Clase de pill según sentimiento. */
export function sentimentClass(sentiment?: Sentiment): string {
  switch (sentiment) {
    case 'positive': return 'pill--positive';
    case 'negative': return 'pill--negative';
    default: return 'pill--neutral';
  }
}

export function kycmLabel(status?: string): string {
  switch (status) {
    case 'verified': return 'KYCM verificado';
    case 'pending': return 'KYCM pendiente';
    default: return 'KYCM sin verificar';
  }
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-NI', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
