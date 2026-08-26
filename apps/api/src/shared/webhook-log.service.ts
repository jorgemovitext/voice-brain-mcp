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

  /**
   * Los guardados en vuelo, encadenados.
   *
   * Se encadenan y no se disparan en paralelo porque cada uno escribe el
   * arreglo COMPLETO: dos `put` simultáneos se pisan y el que llega segundo
   * puede ser el que leyó el estado más viejo.
   */
  private pendiente: Promise<void> = Promise.resolve();

  constructor(config: ConfigService) {
    this.token = config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    this.pathname = config.get<string>('WEBHOOK_LOG_BLOB_PATH', 'brain/webhook-log.json');
  }

  /**
   * Registra el evento. La escritura no bloquea a quien llama, pero queda
   * agendada: hay que cerrarla con `flush()` antes de responder.
   */
  push(source: WebhookEvent['source'], summary: string, ok = true, detail?: unknown): void {
    const evento: WebhookEvent = { at: new Date().toISOString(), source, summary, ok, detail };
    this.events.unshift(evento);
    if (this.events.length > WebhookLogService.MAX) this.events.length = WebhookLogService.MAX;
    if (this.token) this.pendiente = this.pendiente.then(() => this.persist());
  }

  /**
   * Espera a que lo registrado esté realmente guardado.
   *
   * Sin esto la bitácora miente en producción. En serverless la instancia se
   * congela apenas se devuelve la respuesta, así que un guardado disparado y
   * no esperado se pierde a medio camino — y como la copia en memoria muere
   * con la instancia, el evento no queda en ningún lado. El resultado es que
   * "¿el proveedor nos pegó alguna vez?" siempre respondía que no, que es
   * justo la pregunta que hay que contestar cuando un webhook no llega.
   *
   * Lo llaman los controladores de webhook antes de su `return`.
   */
  async flush(): Promise<void> {
    await this.pendiente;
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
