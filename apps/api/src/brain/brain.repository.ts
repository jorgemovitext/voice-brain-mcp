import { Contact, Interaction, Signal } from './types';

/**
 * Puerto de persistencia del Brain. Hoy: memoria + respaldo JSON.
 * Mañana: SQLite/Postgres cambiando el provider en BrainModule.
 */
export interface BrainRepository {
  listContacts(): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  findContactByPhone(phone: string): Promise<Contact | undefined>;
  findContactByExternalId(system: string, externalId: string): Promise<Contact | undefined>;
  saveContact(contact: Contact): Promise<Contact>;

  listInteractions(contactId?: string): Promise<Interaction[]>;
  /** Búsqueda por id: hace barata la idempotencia de la ingesta. */
  findInteraction(id: string): Promise<Interaction | undefined>;
  appendInteraction(interaction: Interaction): Promise<Interaction>;

  listSignals(contactId: string): Promise<Signal[]>;
  saveSignal(signal: Signal): Promise<Signal>;

  /** Borra todo — útil para re-correr la demo desde cero. */
  reset(): Promise<void>;
}

export const BRAIN_REPOSITORY = 'BrainRepository';
