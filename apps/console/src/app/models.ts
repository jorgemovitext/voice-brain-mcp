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

/** Un "obrero": Pearl (agente de voz) de la cuenta NL Pearl. */
export interface Worker {
  id: string;
  name: string;
  status?: string;
  type?: string;
  raw: Record<string, string | number | boolean>;
}

export interface WorkersResponse {
  workers: Worker[];
  /** El Pearl configurado en NLPEARL_PEARL_ID (se resalta en la vista). */
  inUseId: string;
}

export interface WorkerFlow {
  available: boolean;
  flow?: {
    nodes?: Array<{ id: string; type?: string; label?: string; name?: string }>;
    edges?: Array<{ from: string; to: string }>;
  } & Record<string, unknown>;
  message?: string;
}

/** Actividad reciente de webhooks (entrantes y pruebas salientes). */
export interface WebhookEvent {
  at: string;
  source: 'nlpearl' | 'gupshup' | 'whatsapp-cloud' | 'precall' | 'saliente';
  summary: string;
  ok: boolean;
  detail?: unknown;
}

export interface NlpearlTestResult {
  ok: boolean;
  ms: number;
  pearls?: Array<{ id: string; name: string }>;
  total?: number;
  /** El Pearl de NLPEARL_PEARL_ID: si no existe en la cuenta, las llamadas fallarían. */
  pearlEnUso?: { id: string; name: string; valido: boolean };
  error?: string;
}

export interface IntegrationStatus {
  id: 'nlpearl' | 'whatsapp' | 'sms';
  name: string;
  kind: 'voice' | 'messaging';
  connected: boolean;
  mode: string;
  /** Variables de entorno que faltan para conectarla. */
  missing: string[];
  /** Datos públicos para configurar el proveedor (nunca secretos). */
  details: Record<string, string>;
}
