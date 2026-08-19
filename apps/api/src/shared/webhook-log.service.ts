import { Injectable } from '@nestjs/common';

export interface WebhookEvent {
  at: string;
  /** Quién lo envió. */
  source: 'nlpearl' | 'gupshup' | 'whatsapp-cloud' | 'precall' | 'saliente';
  summary: string;
  ok: boolean;
  detail?: unknown;
}

/**
 * Bitácora en memoria de lo que entra y sale por las integraciones.
 *
 * Sirve para responder "¿NL Pearl / Gupshup me está pegando de verdad?" desde
 * la consola, sin abrir los logs de Vercel. En serverless cada instancia tiene
 * la suya, así que muestra la actividad reciente, no un historial completo.
 */
@Injectable()
export class WebhookLogService {
  private static readonly MAX = 40;
  private events: WebhookEvent[] = [];

  push(source: WebhookEvent['source'], summary: string, ok = true, detail?: unknown): void {
    this.events.unshift({ at: new Date().toISOString(), source, summary, ok, detail });
    if (this.events.length > WebhookLogService.MAX) this.events.length = WebhookLogService.MAX;
  }

  list(): WebhookEvent[] {
    return [...this.events];
  }
}
