import { Channel, Sentiment } from './models';

/** Helpers de presentación compartidos por las vistas (español CENAM). */

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

/**
 * Nombre legible de un paso del flujo. Vive acá porque lo leen la vista del
 * caso y el panel de contexto, que desde que se partieron son componentes
 * distintos; con una copia en cada uno, agregar un paso arreglaría solo una.
 */
const PASOS: Record<string, string> = {
  opening: 'Abrió la conversación',
  closing: 'Cerró la conversación',
  emergency: 'Detectó una emergencia',
  identifyNeed: 'Identificó la necesidad',
  escalamiento: 'Escalado al despacho',
  geocodeLocation: 'Ubicación verificada',
  collectDetails: 'Detalles adicionales',
  offerPhoto: 'Solicitud de evidencia',
  safetyCheck: 'Verificación de seguridad',
  collectProblem: 'Recopiló el tipo de problema',
  collectLocation: 'Recopiló la ubicación',
  collectDesc: 'Recopiló la descripción',
  collectContact: 'Recopiló los datos de contacto',
  confirmInfo: 'Confirmó la información',
  registered: 'Registró el reporte',
  consultaTramite: 'Orientó sobre el trámite',
};

export function etiquetaPaso(paso: string): string {
  return PASOS[paso] ?? paso;
}

/** Solo la hora, sin fecha: dentro de un día ya sabido, el resto sobra. */
export function horaCorta(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
}

/** Día y mes, sin año: lo que cabe en una ficha. */
export function fechaCorta(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-NI', { day: 'numeric', month: 'short' });
}

/**
 * Un vistazo, no el texto completo. La descripción del ciudadano puede ocupar
 * un párrafo entero; en una línea de tiempo se corta y el resto queda en el
 * `title`. El texto íntegro vive en la conversación y en la ficha.
 */
export function recorte(valor: string, tope = 80): string {
  const limpio = valor.replace(/\s+/g, ' ').trim();
  if (limpio.length <= tope) return limpio;
  // Se corta en el último espacio para no partir una palabra por la mitad.
  const corte = limpio.slice(0, tope);
  return `${corte.slice(0, corte.lastIndexOf(' ') || tope)}…`;
}

/**
 * Las dos letras de un avatar. Vive acá porque la usan la columna de hilos y
 * el chat, que desde que se partieron son componentes distintos.
 */
export function inicialesDe(name?: string): string {
  return (name || 'Anónimo')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
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
