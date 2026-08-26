import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { digitosDe } from './telefono';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';
import { BrainRepository } from './brain.repository';
import { Contact, Interaction, Signal } from './types';

/**
 * Persistencia del Brain en Postgres (Neon vía Vercel): la definitiva para el
 * giro "espejo de NL Pearl". A diferencia del Blob (snapshot completo con
 * last-write-wins), acá cada escritura es una fila: concurrencia real entre
 * instancias serverless y consultas por contacto/rango sin cargar todo.
 */
@Injectable()
export class PgBrainRepository implements BrainRepository {
  private readonly logger = new Logger(PgBrainRepository.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  /** El módulo solo selecciona este repo cuando hay pool; el assert es defensa. */
  private async db(): Promise<Pool> {
    if (!this.pool) throw new Error('PgBrainRepository sin DATABASE_URL configurada');
    await ensureSchema(this.pool);
    return this.pool;
  }

  // ---- Contactos ----

  private rowToContact(r: Record<string, unknown>): Contact {
    return {
      id: r['id'] as string,
      displayName: (r['display_name'] as string | null) ?? undefined,
      phones: (r['phones'] as string[]) ?? [],
      externalIds: (r['external_ids'] as Record<string, string>) ?? {},
      kycmStatus: ((r['kycm_status'] as string | null) ?? undefined) as Contact['kycmStatus'],
    };
  }

  async listContacts(): Promise<Contact[]> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM contacts ORDER BY display_name NULLS LAST, id');
    return res.rows.map((r) => this.rowToContact(r));
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM contacts WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToContact(res.rows[0]) : undefined;
  }

  async findContactByPhone(phone: string): Promise<Contact | undefined> {
    const db = await this.db();

    // Camino rápido: el formato tal cual vino. Cubre la enorme mayoría.
    const exacto = await db.query('SELECT * FROM contacts WHERE phones @> $1::jsonb LIMIT 1', [
      JSON.stringify([phone]),
    ]);
    if (exacto.rows[0]) return this.rowToContact(exacto.rows[0]);

    /*
     * Y si no, por dígitos: el mismo número llega escrito distinto según el
     * canal (NL Pearl manda `504…`, Gupshup `+504…`), y con igualdad exacta
     * el ciudadano terminaba duplicado en dos contactos.
     *
     * Va DESPUÉS del exacto y dentro de un try a propósito: si esta consulta
     * fallara, la identidad —que es la llave de toda la app— se degrada al
     * comportamiento de siempre en vez de romperse.
     */
    const digitos = digitosDe(phone);
    if (!digitos) return undefined;

    try {
      const res = await db.query(
        `SELECT * FROM contacts
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(phones) AS p
              WHERE regexp_replace(p, '\\D', '', 'g') = $1
           )
           LIMIT 1`,
        [digitos],
      );
      return res.rows[0] ? this.rowToContact(res.rows[0]) : undefined;
    } catch (err) {
      this.logger.warn(`Búsqueda por dígitos falló, se usa solo el formato exacto: ${(err as Error).message}`);
      return undefined;
    }
  }

  async findContactByExternalId(system: string, externalId: string): Promise<Contact | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM contacts WHERE external_ids->>$1 = $2 LIMIT 1', [
      system,
      externalId,
    ]);
    return res.rows[0] ? this.rowToContact(res.rows[0]) : undefined;
  }

  async saveContact(contact: Contact): Promise<Contact> {
    const db = await this.db();
    await db.query(
      `INSERT INTO contacts (id, display_name, phones, external_ids, kycm_status)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         phones = EXCLUDED.phones,
         external_ids = EXCLUDED.external_ids,
         kycm_status = EXCLUDED.kycm_status`,
      [
        contact.id,
        contact.displayName ?? null,
        JSON.stringify(contact.phones ?? []),
        JSON.stringify(contact.externalIds ?? {}),
        contact.kycmStatus ?? null,
      ],
    );
    return contact;
  }

  // ---- Interacciones ----

  private rowToInteraction(r: Record<string, unknown>): Interaction {
    return {
      id: r['id'] as string,
      contactId: r['contact_id'] as string,
      channel: r['channel'] as Interaction['channel'],
      direction: r['direction'] as Interaction['direction'],
      occurredAt: new Date(r['occurred_at'] as string).toISOString(),
      summary: (r['summary'] as string | null) ?? undefined,
      transcript: (r['transcript'] as string | null) ?? undefined,
      sentiment: ((r['sentiment'] as string | null) ?? undefined) as Interaction['sentiment'],
      collectedInfo: (r['collected_info'] as Record<string, unknown> | null) ?? undefined,
      source: ((r['source'] as string | null) ?? undefined) as Interaction['source'],
      handledBy: (r['handled_by'] as string | null) ?? undefined,
      attachment: ((r['attachment'] as string | null) ?? undefined) as Interaction['attachment'],
    };
  }

  async listInteractions(contactId?: string): Promise<Interaction[]> {
    const db = await this.db();
    const res = contactId
      ? await db.query('SELECT * FROM interactions WHERE contact_id = $1 ORDER BY occurred_at ASC', [contactId])
      : await db.query('SELECT * FROM interactions ORDER BY occurred_at ASC');
    return res.rows.map((r) => this.rowToInteraction(r));
  }

  async findInteraction(id: string): Promise<Interaction | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM interactions WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToInteraction(res.rows[0]) : undefined;
  }

  async appendInteraction(interaction: Interaction): Promise<Interaction> {
    return this.guardar(interaction, 'DO NOTHING');
  }

  /** Misma fila, pisando los campos: corrige lo ingerido con un mapeo viejo. */
  async replaceInteraction(interaction: Interaction): Promise<Interaction> {
    return this.guardar(
      interaction,
      `DO UPDATE SET
         contact_id = EXCLUDED.contact_id,
         channel = EXCLUDED.channel,
         direction = EXCLUDED.direction,
         occurred_at = EXCLUDED.occurred_at,
         summary = EXCLUDED.summary,
         transcript = EXCLUDED.transcript,
         sentiment = EXCLUDED.sentiment,
         collected_info = EXCLUDED.collected_info,
         source = EXCLUDED.source,
         handled_by = EXCLUDED.handled_by,
         attachment = EXCLUDED.attachment`,
    );
  }

  private async guardar(interaction: Interaction, alConflicto: string): Promise<Interaction> {
    const db = await this.db();
    await db.query(
      `INSERT INTO interactions (id, contact_id, channel, direction, occurred_at, summary, transcript, sentiment, collected_info, source, handled_by, attachment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       ON CONFLICT (id) ${alConflicto}`,
      [
        interaction.id,
        interaction.contactId,
        interaction.channel,
        interaction.direction,
        interaction.occurredAt,
        interaction.summary ?? null,
        interaction.transcript ?? null,
        interaction.sentiment ?? null,
        interaction.collectedInfo ? JSON.stringify(interaction.collectedInfo) : null,
        interaction.source ?? null,
        interaction.handledBy ?? null,
        interaction.attachment ?? null,
      ],
    );
    return interaction;
  }

  // ---- Señales ----

  private rowToSignal(r: Record<string, unknown>): Signal {
    return {
      id: r['id'] as string,
      contactId: r['contact_id'] as string,
      type: r['type'] as Signal['type'],
      amount: r['amount'] !== null && r['amount'] !== undefined ? Number(r['amount']) : undefined,
      dueDate: (r['due_date'] as string | null) ?? undefined,
      status: ((r['status'] as string | null) ?? undefined) as Signal['status'],
      text: (r['body'] as string | null) ?? undefined,
    };
  }

  async listSignals(contactId?: string): Promise<Signal[]> {
    const db = await this.db();
    const res = contactId
      ? await db.query('SELECT * FROM signals WHERE contact_id = $1', [contactId])
      : await db.query('SELECT * FROM signals');
    return res.rows.map((r) => this.rowToSignal(r));
  }

  async saveSignal(signal: Signal): Promise<Signal> {
    const db = await this.db();
    await db.query(
      `INSERT INTO signals (id, contact_id, type, amount, due_date, status, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         amount = EXCLUDED.amount,
         due_date = EXCLUDED.due_date,
         status = EXCLUDED.status,
         body = EXCLUDED.body`,
      [
        signal.id,
        signal.contactId,
        signal.type,
        signal.amount ?? null,
        signal.dueDate ?? null,
        signal.status ?? null,
        signal.text ?? null,
      ],
    );
    return signal;
  }

  async mergeContacts(keepId: string, dropIds: string[]): Promise<void> {
    if (!dropIds.length) return;
    const db = await this.db();
    const cliente = await db.connect();
    try {
      /*
       * En una transacción: si el borrado de contactos ocurriera sin que las
       * interacciones se hayan movido, quedarían apuntando a un contacto que
       * ya no existe y el hilo se vería vacío sin ningún error visible.
       */
      await cliente.query('BEGIN');
      await cliente.query('UPDATE interactions SET contact_id = $1 WHERE contact_id = ANY($2)', [keepId, dropIds]);
      await cliente.query('UPDATE signals SET contact_id = $1 WHERE contact_id = ANY($2)', [keepId, dropIds]);
      await cliente.query('DELETE FROM contacts WHERE id = ANY($1)', [dropIds]);
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      cliente.release();
    }
  }

  async reset(): Promise<void> {
    const db = await this.db();
    await db.query('TRUNCATE contacts, interactions, signals, nlpearl_pearls, nlpearl_activity');
  }
}
