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
  /** Canal por el que conversa: voice | whatsapp | sms. */
  channel?: string;
  /** Número/canal de texto asignado en NL Pearl. */
  channelLabel?: string;
  /** ¿Puede recibir una prueba ahora mismo? */
  ready?: boolean;
  /** Motivo por el que no puede recibir, cuando aplica. */
  blocker?: string;
  /** Conversaciones ya espejadas en nuestra DB. */
  synced?: number;
  lastActivityAt?: string;
}

/** Qué Pearl atiende cada canal. */
export type PearlRouting = Partial<Record<'voice' | 'whatsapp' | 'sms', string>>;

export interface WorkersResponse {
  workers: Worker[];
  /** Pearl asignada al canal de voz (se resalta en la vista). */
  inUseId: string;
  /** Asignación completa canal → Pearl. */
  routing: PearlRouting;
}

export interface WorkerFlow {
  available: boolean;
  flow?: {
    nodes?: Array<{ id: string; type?: string; label?: string; name?: string }>;
    edges?: Array<{ from: string; to: string }>;
  } & Record<string, unknown>;
  message?: string;
}

/** Estado de la colmena (primera pantalla): GET /api/hive. */
export interface HiveStatus {
  obreros: {
    total: number;
    activos: number;
    enElPanal: Array<{
      id: string;
      name: string;
      channel: Channel;
      synced: number;
      asignada?: boolean;
    }>;
  };
  metricas: {
    contactos: number;
    conversacionesHoy: number;
    esperandoRespuesta: number;
    promesasActivas: number;
  };
  esperando: Array<{
    contactId: string;
    displayName?: string;
    phone?: string;
    channel: Channel;
    summary?: string;
    occurredAt: string;
    waitingMin: number;
  }>;
  actividad: Array<{
    contactId: string;
    displayName?: string;
    channel: Channel;
    direction: 'inbound' | 'outbound';
    summary?: string;
    occurredAt: string;
    source?: string;
  }>;
  canales: { nlpearl: boolean; whatsapp: string; db: string };
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
