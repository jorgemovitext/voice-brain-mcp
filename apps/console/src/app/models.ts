/**
 * Tipos compartidos con el backend (duplicados a propósito para mantener
 * la consola autocontenida; ver apps/api/src/brain/types.ts).
 */

/** `note` = apunte interno del operador: vive en el hilo, nunca viaja al cliente. */
export type Channel = 'voice' | 'whatsapp' | 'sms' | 'note';
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
  /** Agente (Pearl) que atendió esta interacción. */
  handledBy?: string;
  /**
   * La persona mandó un archivo en vez de texto. El archivo NO lo tenemos:
   * NL Pearl entrega esos turnos vacíos y no expone ninguna ruta de media.
   */
  attachment?: 'foto' | 'ubicacion' | 'adjunto';
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
    /** Hilos cuyo último mensaje lo puso el enjambre. */
    hilosAlDia: number;
    /** La espera más larga de la cola, en minutos. */
    maxEsperaMin: number;
    /** Interacciones de hoy por hora (24 casillas). */
    porHora: number[];
  };
  /** Tráfico total por canal, para los anillos y las barras. */
  porCanal: Array<{ channel: Channel; total: number; inbound: number }>;
  /**
   * Pulso en vivo del WhatsApp de NL Pearl (no de nuestra base de datos).
   * `null` = no se pudo consultar (sin Pearl asignada o la API no respondió),
   * distinto de `0` = "consultado, nadie escribiendo ahora".
   */
  enVivo: { total: number; enCola: number | null } | null;
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
  canales: { nlpearl: boolean; whatsappAgentes: string | null; otp: string; db: string };
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

/**
 * Un paso del flujo de la Pearl empujado durante la conversación.
 * NO es un mensaje: NL Pearl no expone el texto de los turnos en vivo, solo
 * las variables que el agente va recopilando.
 */
export interface AvanceFlujo {
  conversationId?: string;
  paso: string;
  datos: Record<string, unknown>;
  occurredAt?: string;
}

/** Un conteo con etiqueta, para rankings del tablero. */
export interface Conteo {
  etiqueta: string;
  total: number;
}

/** Lo que alimenta el tablero analítico bajo La colmena. */
export interface Analytics {
  rango: { desde: string; hasta: string; dias: number };
  resumen: {
    conversaciones: number;
    mensajes: number;
    contactos: number;
    sinRespuesta: number;
    atendidos: number;
    primeraRespuestaMin: number | null;
    duracionMin: number | null;
  };
  porDia: Array<{ dia: string; conversaciones: number; mensajes: number }>;
  porHora: number[];
  porCanal: Array<{ channel: Channel; total: number; inbound: number; outbound: number }>;
  agentes: Array<{ nombre: string; conversaciones: number; mensajes: number; ultima?: string }>;
  problemas: Conteo[];
  ubicaciones: Conteo[];
  sentimiento: { positive: number; neutral: number; negative: number; sinDato: number };
  casos: {
    configurado: boolean;
    motivo?: string;
    total?: number;
    cerrados?: number;
    enCurso?: number;
    porEtapa?: Array<{ etapa: string; total: number; cierraElCaso: boolean }>;
    resolucionHoras?: number | null;
    diferenciaConConversaciones?: number;
  };
  esperandoMas: Array<{
    contactId: string;
    displayName?: string;
    channel: Channel;
    esperaMin: number;
    resumen?: string;
  }>;
  /** Aristas canal → problema → resultado para el mapa de flujo. */
  flujo: Array<{
    canal: Channel;
    problema: string;
    resultado: 'atendida' | 'esperando';
    total: number;
  }>;
}

/** Quién atiende el hilo: el agente (operador null) o una persona. */
export interface Atencion {
  operador: string | null;
  desde?: string;
}

/** Lo que le toca hacer al operador humano en este punto de la conversación. */
export interface AccionSugerida {
  id: string;
  etiqueta: string;
  motivo: string;
  tipo: 'ejecutable' | 'aviso' | 'dato';
  /** Marca el momento en que el flujo del agente habría escalado solo. */
  urgente: boolean;
}

/** Resumen del hilo y su caso en el CRM. */
export interface Expediente {
  resumen: {
    texto: string | null;
    /**
     * `flujo` = lo escribió el agente en una variable del flujo de NL Pearl.
     * `propio` = lo redactamos nosotros desde la transcripción.
     * `agente` = el texto crudo de NL Pearl, solo recortado.
     */
    fuente: 'flujo' | 'propio' | 'agente' | 'datos' | null;
    capturado: Array<{ campo: string; valor: string }>;
  };
  caso: {
    hay: boolean;
    motivo?: string;
    id?: string;
    asunto?: string;
    etapa?: string;
    cerrado?: boolean;
    creado?: string;
    actualizado?: string;
  };
  /**
   * El ciudadano mandó una foto. Solo el hecho: el transcript de NL Pearl no
   * incluye archivos, así que la imagen nunca llega a la app.
   */
  fotoRecibida: boolean;
  atencion: Atencion;
  acciones: AccionSugerida[];
}

/** Estado de un proveedor conectado, tal como lo reporta el gateway. */
export interface Integracion {
  id: string;
  name: string;
  kind: string;
  connected: boolean;
  mode: string;
  missing: string[];
  details: Record<string, string>;
}
