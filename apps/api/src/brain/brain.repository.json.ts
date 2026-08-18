import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { BrainRepository } from './brain.repository';
import { Contact, Interaction, Signal } from './types';

interface BrainSnapshot {
  contacts: Contact[];
  interactions: Interaction[];
  signals: Signal[];
}

/**
 * Implementación en memoria con respaldo a archivo JSON.
 * Carga el snapshot al arrancar y persiste (debounced) tras cada escritura.
 */
@Injectable()
export class JsonBrainRepository implements BrainRepository {
  private readonly logger = new Logger(JsonBrainRepository.name);
  private readonly file: string;

  private contacts = new Map<string, Contact>();
  private interactions: Interaction[] = [];
  private signals: Signal[] = [];

  private persistTimer?: NodeJS.Timeout;
  private loaded = false;

  constructor(config: ConfigService) {
    this.file = path.resolve(process.cwd(), config.get<string>('BRAIN_DATA_FILE', './data/brain.json'));
  }

  /** Carga perezosa del snapshot desde disco (una sola vez). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      const snap: BrainSnapshot = JSON.parse(raw);
      snap.contacts?.forEach((c) => this.contacts.set(c.id, c));
      this.interactions = snap.interactions ?? [];
      this.signals = snap.signals ?? [];
      this.logger.log(`Brain cargado desde ${this.file} (${this.contacts.size} contactos)`);
    } catch {
      this.logger.log(`Sin snapshot previo en ${this.file}; arrancando vacío`);
    }
  }

  /** Persistencia debounced: agrupa escrituras cercanas en un solo write. */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), 150);
  }

  private async persist(): Promise<void> {
    const snap: BrainSnapshot = {
      contacts: [...this.contacts.values()],
      interactions: this.interactions,
      signals: this.signals,
    };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(snap, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`No se pudo persistir el Brain: ${(err as Error).message}`);
    }
  }

  async listContacts(): Promise<Contact[]> {
    await this.ensureLoaded();
    return [...this.contacts.values()];
  }

  async getContact(id: string): Promise<Contact | undefined> {
    await this.ensureLoaded();
    return this.contacts.get(id);
  }

  async findContactByPhone(phone: string): Promise<Contact | undefined> {
    await this.ensureLoaded();
    return [...this.contacts.values()].find((c) => c.phones.includes(phone));
  }

  async findContactByExternalId(system: string, externalId: string): Promise<Contact | undefined> {
    await this.ensureLoaded();
    return [...this.contacts.values()].find((c) => c.externalIds[system] === externalId);
  }

  async saveContact(contact: Contact): Promise<Contact> {
    await this.ensureLoaded();
    this.contacts.set(contact.id, contact);
    this.schedulePersist();
    return contact;
  }

  async listInteractions(contactId?: string): Promise<Interaction[]> {
    await this.ensureLoaded();
    return contactId ? this.interactions.filter((i) => i.contactId === contactId) : [...this.interactions];
  }

  async appendInteraction(interaction: Interaction): Promise<Interaction> {
    await this.ensureLoaded();
    this.interactions.push(interaction);
    this.schedulePersist();
    return interaction;
  }

  async listSignals(contactId: string): Promise<Signal[]> {
    await this.ensureLoaded();
    return this.signals.filter((s) => s.contactId === contactId);
  }

  async saveSignal(signal: Signal): Promise<Signal> {
    await this.ensureLoaded();
    const idx = this.signals.findIndex((s) => s.id === signal.id);
    if (idx >= 0) this.signals[idx] = signal;
    else this.signals.push(signal);
    this.schedulePersist();
    return signal;
  }

  async reset(): Promise<void> {
    this.loaded = true;
    this.contacts.clear();
    this.interactions = [];
    this.signals = [];
    this.schedulePersist();
  }
}
