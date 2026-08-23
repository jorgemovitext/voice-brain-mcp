import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/** Fila del catálogo de pearls espejado. */
export interface StoredPearl {
  id: string;
  name?: string;
  type?: number;
  status?: number;
  /** agentType de NL Pearl: 1 = voz, 2 = texto. Cacheado para no re-consultar. */
  agentType?: number;
  /** Canal con el que se registran sus conversaciones en el Brain. */
  channel: 'voice' | 'sms' | 'whatsapp';
  raw?: unknown;
  syncedAt?: string;
}

/** Fila de actividad raw (llamada o conversación de texto) tal como la dio NL Pearl. */
export interface StoredActivity {
  id: string;
  pearlId?: string;
  phone?: string;
  /**
   * `progress` son los avances estructurados que empuja el flujo durante la
   * conversación (ubicación recopilada, tipo de problema…). No son mensajes:
   * NL Pearl no expone el texto de cada turno en vivo.
   */
  kind: 'call' | 'chat' | 'progress';
  occurredAt?: string;
  raw: unknown;
  ingestedAt?: string;
}

/**
 * Almacén del "espejo NL Pearl": guarda el detalle COMPLETO (raw JSON) de cada
 * pearl y cada llamada/conversación, además de lo que se normaliza al Brain.
 * Así no se pierde nada aunque el mapper todavía no entienda un campo.
 *
 * Sin DATABASE_URL degrada a no-op: el sync sigue alimentando el Brain, solo
 * que sin copia raw consultable.
 */
@Injectable()
export class NlpearlActivityStore {
  private readonly logger = new Logger(NlpearlActivityStore.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  get available(): boolean {
    return !!this.pool;
  }

  private async db(): Promise<Pool | null> {
    if (!this.pool) return null;
    await ensureSchema(this.pool);
    return this.pool;
  }

  async upsertPearl(pearl: StoredPearl): Promise<void> {
    const db = await this.db();
    if (!db) return;
    await db.query(
      `INSERT INTO nlpearl_pearls (id, name, type, status, agent_type, channel, raw, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         agent_type = COALESCE(EXCLUDED.agent_type, nlpearl_pearls.agent_type),
         channel = EXCLUDED.channel,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      [
        pearl.id,
        pearl.name ?? null,
        pearl.type ?? null,
        pearl.status ?? null,
        pearl.agentType ?? null,
        pearl.channel,
        JSON.stringify(pearl.raw ?? null),
      ],
    );
  }

  async listPearls(): Promise<StoredPearl[]> {
    const db = await this.db();
    if (!db) return [];
    const res = await db.query('SELECT * FROM nlpearl_pearls ORDER BY name NULLS LAST');
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      type: r.type ?? undefined,
      status: r.status ?? undefined,
      agentType: r.agent_type ?? undefined,
      channel: r.channel,
      raw: r.raw ?? undefined,
      syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : undefined,
    }));
  }

  /**
   * Guarda una actividad y dice si era NUEVA (primera vez que se ve ese id).
   * En repeticiones actualiza el raw (una llamada puede llegar primero sin
   * transcript y después completa) pero devuelve false para no duplicar la
   * interacción en el Brain.
   */
  async recordActivity(activity: StoredActivity): Promise<{ inserted: boolean }> {
    const db = await this.db();
    // Sin DB no hay dedupe por tabla: se reporta como nueva y el dedupe lo
    // hace el id determinista de la interacción (nlpearl:<id>).
    if (!db) return { inserted: true };
    const res = await db.query(
      `INSERT INTO nlpearl_activity (id, pearl_id, phone, kind, occurred_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET raw = EXCLUDED.raw, occurred_at = EXCLUDED.occurred_at
       RETURNING (xmax = 0) AS inserted`,
      [
        activity.id,
        activity.pearlId ?? null,
        activity.phone ?? null,
        activity.kind,
        activity.occurredAt ?? null,
        JSON.stringify(activity.raw),
      ],
    );
    return { inserted: res.rows[0]?.inserted === true };
  }

  /**
   * Cuántas conversaciones se espejaron por Pearl y cuándo fue la última.
   * Es lo que permite ver de un vistazo si una prueba llegó o no.
   */
  async countsByPearl(): Promise<Map<string, { total: number; last?: string }>> {
    const db = await this.db();
    const out = new Map<string, { total: number; last?: string }>();
    if (!db) return out;
    const res = await db.query(
      `SELECT pearl_id, count(*)::int AS total, max(occurred_at) AS last
       FROM nlpearl_activity WHERE pearl_id IS NOT NULL GROUP BY pearl_id`,
    );
    for (const r of res.rows) {
      out.set(r.pearl_id, {
        total: r.total,
        last: r.last ? new Date(r.last).toISOString() : undefined,
      });
    }
    return out;
  }

  async listActivity(opts: { pearlId?: string; phone?: string; limit?: number } = {}): Promise<StoredActivity[]> {
    const db = await this.db();
    if (!db) return [];
    const limit = Math.min(opts.limit ?? 50, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.pearlId) {
      params.push(opts.pearlId);
      where.push(`pearl_id = $${params.length}`);
    }
    if (opts.phone) {
      params.push(opts.phone);
      where.push(`phone = $${params.length}`);
    }
    params.push(limit);
    const res = await db.query(
      `SELECT * FROM nlpearl_activity
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC NULLS LAST
       LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      pearlId: r.pearl_id ?? undefined,
      phone: r.phone ?? undefined,
      kind: r.kind,
      occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : undefined,
      raw: r.raw,
      ingestedAt: r.ingested_at ? new Date(r.ingested_at).toISOString() : undefined,
    }));
  }
}
