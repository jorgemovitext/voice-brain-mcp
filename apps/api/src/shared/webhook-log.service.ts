import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from './database.module';
import { SettingsService } from './settings.service';

export interface WebhookEvent {
  at: string;
  /** Quién lo envió. */
  source: 'nlpearl' | 'gupshup' | 'whatsapp-cloud' | 'precall' | 'saliente' | 'agente' | 'desconocido';
  summary: string;
  ok: boolean;
  detail?: unknown;
}

/** La clave donde vive la bitácora. */
const CLAVE = 'bitacora:webhooks';

/** Encabezado del evento que avisa que la bitácora no se está guardando. */
const AVISO = 'La bitácora no se está guardando';

/**
 * Bitácora de lo que entra y sale por las integraciones.
 *
 * Vive en Postgres —donde vive todo lo demás— porque en serverless cada
 * instancia tiene su propia memoria: sin persistirla es imposible responder
 * "¿el proveedor nos pegó alguna vez?", que es justo lo que hace falta cuando
 * un webhook no llega.
 *
 * Antes se guardaba en Vercel Blob. Al mudar el almacenamiento a Neon, el
 * store de Blob quedó desconectado y su token vacío, así que la bitácora pasó
 * a ser solo memoria: Actividad mostraba "sin actividad registrada todavía"
 * por más llamadas y WhatsApps que entraran. El síntoma y el diagnóstico
 * fallaban a la vez, que es lo peor que puede hacer una herramienta de
 * diagnóstico.
 *
 * Sin Postgres cae al archivo de ajustes (desarrollo).
 */
@Injectable()
export class WebhookLogService {
  private static readonly MAX = 60;
  private readonly logger = new Logger(WebhookLogService.name);

  /** Lo de esta instancia: se muestra aunque el guardado todavía no cierre. */
  private events: WebhookEvent[] = [];

  /**
   * Los guardados en vuelo, encadenados.
   *
   * Se encadenan y no se disparan en paralelo porque comparten la misma fila:
   * dos escrituras simultáneas de la misma instancia se pisarían entre sí.
   */
  private pendiente: Promise<void> = Promise.resolve();

  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Registra el evento. La escritura no bloquea a quien llama, pero queda
   * agendada: hay que cerrarla con `flush()` antes de responder.
   */
  push(source: WebhookEvent['source'], summary: string, ok = true, detail?: unknown): void {
    const evento: WebhookEvent = { at: new Date().toISOString(), source, summary, ok, detail };
    this.events.unshift(evento);
    if (this.events.length > WebhookLogService.MAX) this.events.length = WebhookLogService.MAX;
    this.pendiente = this.pendiente.then(() => this.persist(evento));
  }

  /**
   * Espera a que lo registrado esté realmente guardado.
   *
   * Sin esto la bitácora miente en producción. En serverless la instancia se
   * congela apenas se devuelve la respuesta, así que un guardado disparado y
   * no esperado se pierde a medio camino — y como la copia en memoria muere
   * con la instancia, el evento no queda en ningún lado.
   *
   * Lo llaman los controladores de webhook antes de su `return`.
   */
  async flush(): Promise<void> {
    await this.pendiente;
  }

  async list(): Promise<WebhookEvent[]> {
    const guardados = (await this.leer()) ?? [];
    // Une lo guardado con lo de esta instancia: un evento recién registrado se
    // ve aunque su escritura todavía no haya cerrado.
    const vistos = new Set<string>();
    return [...this.events, ...guardados]
      .filter((e) => {
        const clave = `${e.at}|${e.summary}`;
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      })
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, WebhookLogService.MAX);
  }

  private async leer(): Promise<WebhookEvent[] | undefined> {
    try {
      return await this.settings.get<WebhookEvent[]>(CLAVE);
    } catch (err) {
      this.logger.warn(`No se pudo leer la bitácora: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Agrega UN evento al principio y recorta, en una sola sentencia.
   *
   * No es leer-modificar-escribir a propósito: dos webhooks que caen en
   * instancias distintas al mismo tiempo leerían la misma lista y el segundo
   * en escribir borraría el evento del primero — y perder eventos es
   * exactamente lo que esta bitácora no puede hacer. Postgres concatena y
   * recorta del lado del servidor, así que los dos entran.
   */
  private async persist(evento: WebhookEvent): Promise<void> {
    try {
      if (!this.pool) {
        const previos = (await this.leer()) ?? [];
        await this.settings.set(CLAVE, [evento, ...previos].slice(0, WebhookLogService.MAX));
        return;
      }

      await ensureSchema(this.pool);
      /*
       * `WITH ORDINALITY` y no `LIMIT`: sin una posición explícita, el orden en
       * que salen los elementos de un `jsonb_array_elements` no está
       * garantizado por el estándar, y recortar sin orden podría tirar el
       * evento nuevo en vez del más viejo. Verificado contra Postgres: siete
       * inserciones con tope de cinco dejan los cinco últimos, el nuevo
       * primero.
       */
      await this.pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET
           value = (
             SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
             FROM jsonb_array_elements(EXCLUDED.value || app_settings.value)
                  WITH ORDINALITY AS t(e, ord)
             WHERE ord <= $3
           ),
           updated_at = now()`,
        [CLAVE, JSON.stringify([evento]), WebhookLogService.MAX],
      );
    } catch (err) {
      this.avisarQueNoSeGuarda((err as Error).message);
    }
  }

  /**
   * Deja constancia EN LA PROPIA BITÁCORA de que no se pudo guardar.
   *
   * Un `logger.warn` no lo ve nadie: hay que ir a los registros de Vercel a
   * buscarlo, y para eso primero habría que sospechar. Justamente lo que pasó
   * con el store de Blob desconectado — la lista se veía vacía y no había nada
   * que dijera por qué, así que parecía que los proveedores no estaban
   * pegando. Este evento vive solo en memoria (no se intenta persistir, que es
   * lo que está fallando) y se ve en la misma vista donde se nota el hueco.
   */
  private avisarQueNoSeGuarda(motivo: string): void {
    this.logger.warn(`No se pudo persistir la bitácora: ${motivo}`);
    if (this.events.some((e) => e.summary.startsWith(AVISO))) return;
    this.events.unshift({
      at: new Date().toISOString(),
      source: 'desconocido',
      summary: `${AVISO}: ${motivo}`,
      ok: false,
    });
  }
}
