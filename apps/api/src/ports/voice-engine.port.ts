import { NlpearlCallContext } from '../brain/types';

/**
 * Puerto del motor de voz. NlpearlModule lo implementa dos veces:
 * mock (MOCK=true) y real (cliente HTTP v2). BrainModule y DemoModule
 * solo conocen este puerto, nunca el cliente concreto.
 */
export interface StartCallInput {
  phone: string; // E.164
  externalId: string; // nuestro contactId — llave de unión con NL Pearl
  variables?: Record<string, string>;
  /**
   * Pearl a usar en ESTA llamada. Si se omite se toma la asignada al canal
   * de voz en la app, así se puede alternar sin tocar configuración.
   */
  pearlId?: string;
}

export interface VoiceEnginePort {
  /** Dispara una llamada saliente (en v2: Add Lead sobre el Pearl outbound). */
  startCall(input: StartCallInput): Promise<{ leadId: string }>;
  /** Recupera el contexto completo de una llamada finalizada. */
  getCallContext(callId: string): Promise<NlpearlCallContext>;
  /**
   * Solo mock: simula una llamada ENTRANTE desde un número (conversa y emite
   * el webhook). En producción las entrantes llegan solas por el webhook.
   */
  simulateInboundCall?(phone: string): Promise<{ callId: string }>;
}

export const VOICE_ENGINE_PORT = 'VoiceEnginePort';
