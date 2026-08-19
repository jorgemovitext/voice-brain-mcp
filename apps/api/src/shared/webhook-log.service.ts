import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { get, put } from '@vercel/blob';

export interface WebhookEvent {
  at: string;
  /** Quién lo envió. */
  source: 'nlpearl' | 'gupshup' | 'whatsapp-cloud' | 'precall' | 'saliente' | 'desconocido';
  summary: string;
  ok: boolean;
  detail?: unknown;
}

/**
 * Bitácora de lo que entra y sale por las integraciones.
 *
 * Se persiste en Blob (si hay store) porque en serverless cada instancia tiene
 * su propia memoria: sin esto es imposible responder "¿el proveedor nos pegó
 * alguna vez?", que es justo lo que hace falta cuando un webhook no llega.
 */
@Injectable()
export class WebhookLogService {
  private static readonly MAX = 60;
  private readonly logger = new Logger(WebhookLogService.name);
  private readonly token: string;
  private readonly pathname: string;

  private events: WebhookEvent[] = [];
  private loadedAt = 0;

  constructor(config: ConfigService) {
    this.token = config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    this.pathname = config.get<string>('WEBHOOK_LOG_BLOB_PATH', 'brain/webhook-log.json');
  }

  /** Registra el evento; la persistencia va detrás sin bloquear la respuesta. */
  push(source: WebhookEvent['source'], summary: string, ok = true, detail?: unknown): void {
    const evento: WebhookEvent = { at: new Date().toISOString(), source, summary, ok, detail };
    this.events.unshift(evento);
    if (this.events.length > WebhookLogService.MAX) this.events.length = WebhookLogService.MAX;
    if (this.token) void this.persist();
  }

  async list(): Promise<WebhookEvent[]> {
    if (!this.token) return [...this.events];
    await this.load();
    return [...this.events];
  }

  private async load(): Promise<void> {
    // Copia local válida por un rato: la bitácora no necesita ser exacta.
    if (Date.now() - this.loadedAt < 1000) return;
    try {
      const res = await get(this.pathname, { access: 'private', token: this.token, useCache: false });
      if (res?.stream) {
        const remotos = JSON.parse(await new Response(res.stream).text()) as WebhookEvent[];
        // Une por marca de tiempo + resumen y deja los más recientes primero.
        const vistos = new Set<string>();
        this.events = [...this.events, ...remotos]
          .filter((e) => {
            const clave = `${e.at}|${e.summary}`;
            if (vistos.has(clave)) return false;
            vistos.add(clave);
            return true;
          })
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, WebhookLogService.MAX);
      }
    } catch {
      // Todavía no existe el blob: se queda lo local.
    }
    this.loadedAt = Date.now();
  }

  private async persist(): Promise<void> {
    try {
      await this.load();
      await put(this.pathname, JSON.stringify(this.events), {
        access: 'private',
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0,
      });
      this.loadedAt = Date.now();
    } catch (err) {
      this.logger.warn(`No se pudo persistir la bitácora: ${(err as Error).message}`);
    }
  }
}
