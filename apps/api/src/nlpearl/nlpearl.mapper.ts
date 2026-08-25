import { Channel, Interaction, NlpearlCallContext } from '../brain/types';
import { NlpearlCallApiView } from './nlpearl.client';

/** Canales por los que puede conversar un Pearl (una Pearl nunca "anota"). */
export type PearlChannel = Exclude<Channel, 'note'>;

/**
 * Canal por el que conversa un Pearl.
 *
 * Lo decide `agentType` (1 = voz, 2 = texto), que es el dato real de NL Pearl;
 * el nombre solo desempata entre WhatsApp y SMS, y sirve de respaldo en
 * pearls sin settings legibles (borradores).
 */
export function canalDePearl(name: string | undefined, agentType: number | undefined): PearlChannel {
  const nombre = name ?? '';
  const esTexto = agentType === 2 || (agentType === undefined && (/\b(text|sms|chat)\b/i.test(nombre) || /whats/i.test(nombre)));
  if (!esTexto) return 'voice';
  return /whats\s?app|\bwa\b/i.test(nombre) ? 'whatsapp' : 'sms';
}

/**
 * Normaliza el payload de llamada de NL Pearl (CallApiView de getCall /
 * getCallsBulk / webhook) a la forma que consume el Brain.
 */

/**
 * Normaliza el transcript que manda una acción post-conversación del flujo.
 *
 * La variable `post_call_transcript` no siempre llega como el array de
 * `{role, content}` del CallApiView: el nodo castea cada variable a su tipo
 * configurado y suele entregarla como TEXTO ya formateado. Se aceptan las
 * dos formas.
 *
 * El escaneo de etiquetas es GLOBAL sobre el texto entero, no línea por
 * línea: NL Pearl a veces manda toda la conversación en una sola línea,
 * `[User]: hola [Pearl]: bienvenido [User]: ...`, sin saltos entre turnos.
 * Dividir por `\n` primero (como hacía antes) hacía que, al no haber ningún
 * salto de línea, ninguna etiqueta calzara al inicio de línea y la
 * conversación ENTERA cayera en un solo turno — el bug real: un chat de
 * varios mensajes pintado como una sola burbuja gigante en la consola.
 * Los corchetes alrededor de la etiqueta (`[User]:`) son opcionales.
 */
export function normalizarTranscript(crudo: unknown): NlpearlCallApiView['transcript'] {
  if (Array.isArray(crudo)) return crudo as NlpearlCallApiView['transcript'];
  if (typeof crudo !== 'string' || !crudo.trim()) return undefined;

  const texto = crudo.trim();
  const ETIQUETA =
    /\[?\s*(agent|agente|pearl|assistant|bot|ia|client|cliente|user|usuario|persona|caller)\s*\]?\s*[:>-]\s*/gi;
  const cortes = [...texto.matchAll(ETIQUETA)];

  // Sin ninguna etiqueta reconocible: no hay dónde partir, se atribuye
  // entero al cliente, el lado seguro.
  if (!cortes.length) {
    return [{ role: 'client', content: texto }] as NlpearlCallApiView['transcript'];
  }

  const turnos: Array<{ role: string; content: string }> = [];
  const preludio = texto.slice(0, cortes[0].index).trim();
  if (preludio) turnos.push({ role: 'client', content: preludio });

  for (const [i, corte] of cortes.entries()) {
    const inicio = corte.index + corte[0].length;
    const fin = cortes[i + 1]?.index ?? texto.length;
    const contenido = texto.slice(inicio, fin).trim();
    if (contenido) turnos.push({ role: corte[1].toLowerCase(), content: contenido });
  }

  return turnos as NlpearlCallApiView['transcript'];
}

/** overallSentiment v2 es un entero 1 (negativo) .. 5 (positivo). */
function mapSentiment(overall?: number): NlpearlCallContext['sentiment'] {
  if (overall === undefined || overall === null) return undefined;
  if (overall <= 2) return 'negative';
  if (overall >= 4) return 'positive';
  return 'neutral';
}

/**
 * ¿Ese turno lo escribió nuestro lado?
 *
 * En NL Pearl v2 `role` es un enum NUMÉRICO: 2 = Pearl (el agente),
 * 3 = Client (la persona), 4 = PlatformUser (un humano del equipo tomando el
 * hilo — también nuestro lado). Se aceptan además las variantes en texto
 * porque las usan el simulador y algunos payloads de webhook.
 *
 * Ante un rol desconocido se asume cliente: atribuirle al agente algo que no
 * dijo es peor que lo contrario.
 */
function esDelAgente(role: unknown): boolean {
  if (typeof role === 'number') return role === ROLE_PEARL || role === ROLE_PLATFORM_USER;
  if (typeof role === 'string') {
    const limpio = role.trim();
    // Un número servido como texto ("2") sigue siendo el enum.
    if (/^\d+$/.test(limpio)) return esDelAgente(Number(limpio));
    return /^ia$/i.test(limpio) || /assistant|agent|bot|pearl/i.test(limpio);
  }
  return false;
}

const ROLE_PEARL = 2;
const ROLE_PLATFORM_USER = 4;

/** transcript v2 es un array de mensajes {role, content}; lo aplanamos a texto legible. */
function mapTranscript(transcript?: NlpearlCallApiView['transcript']): string | undefined {
  if (!transcript?.length) return undefined;
  return transcript.map((m) => `${esDelAgente(m.role) ? 'Agente' : 'Cliente'}: ${m.content}`).join('\n');
}

/** collectedInfo v2 es un array {id, name, value}; lo volvemos un objeto por nombre. */
function mapCollectedInfo(info?: NlpearlCallApiView['collectedInfo']): Record<string, unknown> | undefined {
  if (!info?.length) return undefined;
  return Object.fromEntries(info.map((v) => [v.name, v.value]));
}

/**
 * Qué mandó la persona cuando no mandó texto.
 *
 * NL Pearl entrega esos turnos VACÍOS: `{role: 3, content: ""}`, sin tipo, sin
 * URL y sin ningún campo extra (el esquema del transcript es
 * `{role, content, startTime, endTime}` con `additionalProperties: false`, y
 * no hay ruta de media: `/Call/{id}/Media|Attachments|Recording` dan 404).
 * O sea que el archivo no existe para nosotros y el tipo tampoco viene.
 *
 * `adjunto` es el caso honesto: sabemos que mandó algo y nada más.
 */
export type AdjuntoTipo = 'foto' | 'ubicacion' | 'adjunto';

/** Un mensaje suelto de una conversación de texto (SMS/WhatsApp). */
export interface ChatMessage {
  /** `agent` = la Pearl contestando; `customer` = la persona escribiendo. */
  role: 'agent' | 'customer';
  content: string;
  /** Momento del mensaje, ISO 8601. */
  at: string;
  /** Presente solo si el turno no traía texto: la persona mandó un archivo. */
  adjunto?: AdjuntoTipo;
}

/**
 * De qué era el adjunto, deducido de lo que el agente contestó justo después.
 *
 * Es la ÚNICA señal disponible: el turno vacío no dice nada de sí mismo. Si el
 * agente no lo menciona, se queda en `adjunto` en vez de inventar un tipo.
 */
function tipoDeAdjunto(
  transcript: NonNullable<NlpearlCallApiView['transcript']>,
  desde: number,
): AdjuntoTipo {
  for (let i = desde + 1; i < transcript.length; i++) {
    const m = transcript[i];
    const texto = typeof m.content === 'string' ? m.content : '';
    if (!texto.trim()) continue;
    if (!esDelAgente(m.role)) break; // habló la persona antes que el agente
    if (/\bfotos?\b|\bimagen|fotograf/i.test(texto)) return 'foto';
    if (/ubicaci|ubiqu[eé]|el punto|\bpin\b|mapa|coordenada/i.test(texto)) return 'ubicacion';
    break;
  }
  return 'adjunto';
}

/** Lo que se guarda como texto del mensaje cuando el turno fue un adjunto. */
const ETIQUETA_ADJUNTO: Record<AdjuntoTipo, string> = {
  foto: 'Foto recibida',
  ubicacion: 'Ubicación compartida',
  adjunto: 'Adjunto recibido',
};

/**
 * Convierte el transcript en mensajes sueltos para pintarlos como chat.
 *
 * En voz el transcript es el registro de una llamada y se guarda como un solo
 * bloque; en texto CADA entrada es un mensaje real del hilo, así que se
 * separan para que la conversación se vea como tal (y se distinga quién
 * escribió qué).
 *
 * Los turnos sin texto NO se descartan: son las fotos y las ubicaciones que
 * manda la persona por WhatsApp. Descartarlos dejaba el hilo con agujeros —
 * el agente agradecía una foto que nunca aparecía.
 */
export function toChatMessages(call: NlpearlCallApiView): ChatMessage[] {
  const base = call.startTime ? new Date(call.startTime).getTime() : Date.now();
  const transcript = call.transcript ?? [];

  // flatMap sobre el array ORIGINAL: `tipoDeAdjunto` mira los turnos vecinos
  // por índice, así que filtrar antes desalinearía la vecindad.
  return transcript.flatMap((m, i) => {
    if (typeof m.content !== 'string') return [];
    const texto = m.content.trim();
    const at = new Date(momentoDe(base, m.startTime, i)).toISOString();
    const role = esDelAgente(m.role) ? ('agent' as const) : ('customer' as const);
    if (texto) return [{ role, content: texto, at }];

    const adjunto = tipoDeAdjunto(transcript, i);
    return [{ role, content: ETIQUETA_ADJUNTO[adjunto], at, adjunto }];
  });
}

/**
 * `startTime` viene como offset en segundos desde el inicio; en algunos
 * payloads llega como epoch en milisegundos. Se distingue por magnitud, y sin
 * dato se separa un segundo por mensaje para conservar el orden del hilo.
 */
function momentoDe(base: number, startTime: number | undefined, index: number): number {
  if (typeof startTime !== 'number' || !Number.isFinite(startTime)) return base + index * 1000;
  if (startTime > 1e11) return startTime; // epoch en ms
  return base + startTime * 1000; // offset en segundos
}

export function toCallContext(call: NlpearlCallApiView): NlpearlCallContext {
  const direction = call.direction ?? 'outbound';
  return {
    callId: call.id,
    pearlId: call.pearlId,
    // El teléfono del cliente: saliente → "to"; entrante → "from".
    phoneNumber: direction === 'inbound' ? call.from : call.to,
    externalId: call.externalId,
    startedAt: call.startTime,
    endedAt:
      call.startTime && call.duration
        ? new Date(new Date(call.startTime).getTime() + call.duration * 1000).toISOString()
        : call.startTime,
    direction,
    transcript: mapTranscript(call.transcript),
    summary: call.summary,
    sentiment: mapSentiment(call.overallSentiment),
    collectedInfo: mapCollectedInfo(call.collectedInfo),
    recordingUrl: call.recording,
  };
}

/** Llamada NL Pearl → Interaction del Brain (channel voice, source nlpearl). */
export function toInteraction(call: NlpearlCallApiView, contactId: string): Omit<Interaction, 'id'> {
  const ctx = toCallContext(call);
  return {
    contactId,
    channel: 'voice',
    direction: ctx.direction ?? 'outbound',
    occurredAt: ctx.endedAt ?? new Date().toISOString(),
    summary: ctx.summary,
    transcript: ctx.transcript,
    sentiment: ctx.sentiment,
    collectedInfo: ctx.collectedInfo,
    source: 'nlpearl',
  };
}
