/**
 * Tipos compartidos con el backend (duplicados a propósito para mantener
 * la consola autocontenida; ver apps/api/src/brain/types.ts).
 */

export type Channel = 'voice' | 'whatsapp' | 'sms';
export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Contact {
  id: string;
  displayName?: string;
  phones: string[];
  externalIds: Record<string, string>;
  kycmStatus?: 'verified' | 'pending' | 'unverified';
}

export interface Interaction {
  id: string;
  contactId: string;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  occurredAt: string;
  summary?: string;
  transcript?: string;
  sentiment?: Sentiment;
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
  recentInteractions: Interaction[];
  signals: Signal[];
  sentimentTrend?: string;
}

export interface ContactListItem extends Contact {
  lastInteraction?: Pick<Interaction, 'channel' | 'occurredAt' | 'summary' | 'sentiment'>;
  activePromise?: Signal;
}

export interface FlowStep {
  at: string;
  step: string;
  title: string;
  detail?: unknown;
}

export interface DemoStatus {
  running: boolean;
  steps: FlowStep[];
}
