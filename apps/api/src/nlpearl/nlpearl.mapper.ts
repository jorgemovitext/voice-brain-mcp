import { Interaction, NlpearlCallContext } from '../brain/types';
import { NlpearlCallApiView } from './nlpearl.client';

/**
 * Normaliza el payload de llamada de NL Pearl (CallApiView de getCall /
 * getCallsBulk / webhook) a la forma que consume el Brain.
 */

/** overallSentiment v2 es un entero 1 (negativo) .. 5 (positivo). */
function mapSentiment(overall?: number): NlpearlCallContext['sentiment'] {
  if (overall === undefined || overall === null) return undefined;
  if (overall <= 2) return 'negative';
  if (overall >= 4) return 'positive';
  return 'neutral';
}

/** transcript v2 es un array de mensajes {role, content}; lo aplanamos a texto legible. */
function mapTranscript(transcript?: NlpearlCallApiView['transcript']): string | undefined {
  if (!transcript?.length) return undefined;
  return transcript.map((m) => `${m.role === 'assistant' ? 'Agente' : 'Cliente'}: ${m.content}`).join('\n');
}

/** collectedInfo v2 es un array {id, name, value}; lo volvemos un objeto por nombre. */
function mapCollectedInfo(info?: NlpearlCallApiView['collectedInfo']): Record<string, unknown> | undefined {
  if (!info?.length) return undefined;
  return Object.fromEntries(info.map((v) => [v.name, v.value]));
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
