import { Inject, Injectable, Optional } from '@nestjs/common';
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
    const res = await db.query('SELECT * FROM contacts WHERE phones @> $1::jsonb LIMIT 1', [
      JSON.stringify([phone]),
    ]);
    return res.rows[0] ? this.rowToContact(res.rows[0]) : undefined;
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
    const db = await this.db();
    await db.query(
      `INSERT INTO interactions (id, contact_id, channel, direction, occurred_at, summary, transcript, sentiment, collected_info, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (id) DO NOTHING`,
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

  async listSignals(contactId: string): Promise<Signal[]> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM signals WHERE contact_id = $1', [contactId]);
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

  async reset(): Promise<void> {
    const db = await this.db();
    await db.query('TRUNCATE contacts, interactions, signals, nlpearl_pearls, nlpearl_activity');
  }
}
