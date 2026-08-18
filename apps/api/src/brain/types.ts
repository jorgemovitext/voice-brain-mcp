/**
 * Modelo de datos del Brain: el contexto unificado por contacto,
 * independiente del canal (voz / WhatsApp / SMS).
 */

export type Channel = 'voice' | 'whatsapp' | 'sms';

export interface Contact {
  id: string; // ID unificado propio
  displayName?: string;
  phones: string[]; // E.164
  externalIds: Record<string, string>; // { sender: "...", nlpearl: "..." }
  kycmStatus?: 'verified' | 'pending' | 'unverified';
}

export interface Interaction {
  id: string;
  contactId: string;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  occurredAt: string; // ISO 8601
  summary?: string;
  transcript?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  collectedInfo?: Record<string, unknown>;
  source?: 'nlpearl' | 'own';
}

export interface Signal {
  id: string;
  contactId: string;
  type: 'promise' | 'flag' | 'note';
  amount?: number;
  dueDate?: string;
  status?: 'active' | 'kept' | 'broken';
  text?: string;
}

export interface UnifiedContext {
  contact: Contact;
  recentInteractions: Interaction[]; // cross-channel, ordenadas (más reciente primero)
  signals: Signal[];
  sentimentTrend?: string;
}

/** Item enriquecido para el listado de contactos de la consola. */
export interface ContactListItem extends Contact {
  lastInteraction?: Pick<Interaction, 'channel' | 'occurredAt' | 'summary' | 'sentiment'>;
  activePromise?: Signal;
}

/**
 * Forma normalizada de una llamada de NL Pearl tal como la consume el Brain.
 * El mapper de nlpearl convierte el payload real (getCall / getCallsBulk / webhook)
 * a esta forma antes de entregarla al Brain.
 * // TODO: confirmar shape real con NL Pearl
 */
export interface NlpearlCallContext {
  callId: string;
  pearlId?: string;
  phoneNumber?: string;
  externalId?: string;
  startedAt?: string;
  endedAt?: string;
  direction?: 'inbound' | 'outbound';
  transcript?: string;
  summary?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  collectedInfo?: Record<string, unknown>;
  recordingUrl?: string;
}
