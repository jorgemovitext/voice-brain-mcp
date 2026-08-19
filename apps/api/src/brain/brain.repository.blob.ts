import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { head, put } from '@vercel/blob';
import { BrainRepository } from './brain.repository';
import { Contact, Interaction, Signal } from './types';

interface BrainSnapshot {
  contacts: Contact[];
  interactions: Interaction[];
  signals: Signal[];
}

const EMPTY: BrainSnapshot = { contacts: [], interactions: [], signals: [] };

/**
 * Persistencia del Brain en Vercel Blob: un único JSON compartido por TODAS
 * las instancias serverless.
 *
 * Sin esto, cada lambda guarda su propio archivo en /tmp: un contacto creado
 * en una instancia no existe en la siguiente, y los mensajes que entran por
 * webhook no aparecen en la consola. Con Blob el estado es uno solo.
 *
 * Limitación asumida (prototipo): se guarda el snapshot completo con
 * last-write-wins. Dos escrituras simultáneas pueden pisarse; para producción
 * de verdad, mover a Postgres/Redis implementando este mismo puerto.
 */
@Injectable()
export class BlobBrainRepository implements BrainRepository {
  private readonly logger = new Logger(BlobBrainRepository.name);
  private readonly token: string;
  private readonly pathname: string;

  /** Copia en memoria + momento de la última lectura remota. */
  private snapshot: BrainSnapshot = { ...EMPTY };
  private loadedAt = 0;
  /** Ventana en la que se reutiliza la copia local sin volver a leer. */
  private static readonly FRESH_MS = 1500;

  constructor(config: ConfigService) {
    this.token = config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    this.pathname = config.get<string>('BRAIN_BLOB_PATH', 'brain/state.json');
  }

  /** Relee del blob salvo que la copia local sea muy reciente. */
  private async fresh(force = false): Promise<BrainSnapshot> {
    if (!force && Date.now() - this.loadedAt < BlobBrainRepository.FRESH_MS) return this.snapshot;

    try {
      const meta = await head(this.pathname, { token: this.token });
      // El blob es público y pasa por CDN: se evita la caché para no leer viejo.
      const res = await fetch(`${meta.url}?ts=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) this.snapshot = { ...EMPTY, ...((await res.json()) as BrainSnapshot) };
    } catch {
      // Todavía no existe el blob (primer arranque): se queda el estado actual.
    }
    this.loadedAt = Date.now();
    return this.snapshot;
  }

  private async persist(): Promise<void> {
    try {
      await put(this.pathname, JSON.stringify(this.snapshot), {
        access: 'public',
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0,
      });
      this.loadedAt = Date.now();
    } catch (err) {
      this.logger.error(`No se pudo persistir el Brain en Blob: ${(err as Error).message}`);
    }
  }

  async listContacts(): Promise<Contact[]> {
    return (await this.fresh()).contacts;
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return (await this.fresh()).contacts.find((c) => c.id === id);
  }

  async findContactByPhone(phone: string): Promise<Contact | undefined> {
    return (await this.fresh()).contacts.find((c) => c.phones.includes(phone));
  }

  async findContactByExternalId(system: string, externalId: string): Promise<Contact | undefined> {
    return (await this.fresh()).contacts.find((c) => c.externalIds[system] === externalId);
  }

  async saveContact(contact: Contact): Promise<Contact> {
    // Relectura forzada antes de escribir: reduce el riesgo de pisar cambios
    // hechos por otra instancia entre medio.
    const snap = await this.fresh(true);
    const idx = snap.contacts.findIndex((c) => c.id === contact.id);
    if (idx >= 0) snap.contacts[idx] = contact;
    else snap.contacts.push(contact);
    await this.persist();
    return contact;
  }

  async listInteractions(contactId?: string): Promise<Interaction[]> {
    const snap = await this.fresh();
    return contactId ? snap.interactions.filter((i) => i.contactId === contactId) : [...snap.interactions];
  }

  async appendInteraction(interaction: Interaction): Promise<Interaction> {
    const snap = await this.fresh(true);
    snap.interactions.push(interaction);
    await this.persist();
    return interaction;
  }

  async listSignals(contactId: string): Promise<Signal[]> {
    return (await this.fresh()).signals.filter((s) => s.contactId === contactId);
  }

  async saveSignal(signal: Signal): Promise<Signal> {
    const snap = await this.fresh(true);
    const idx = snap.signals.findIndex((s) => s.id === signal.id);
    if (idx >= 0) snap.signals[idx] = signal;
    else snap.signals.push(signal);
    await this.persist();
    return signal;
  }

  async reset(): Promise<void> {
    this.snapshot = { ...EMPTY, contacts: [], interactions: [], signals: [] };
    await this.persist();
  }
}
