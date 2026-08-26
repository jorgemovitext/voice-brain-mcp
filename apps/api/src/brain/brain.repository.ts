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
  /**
   * Reescribe una interacción ya guardada. Solo lo usa la reingesta, cuando
   * un dato mal mapeado en su momento (p. ej. quién habló) hay que corregirlo
   * sobre el registro que ya existe.
   */
  replaceInteraction(interaction: Interaction): Promise<Interaction>;

  /** Sin contactId devuelve TODAS: evita el N+1 al armar el listado. */
  listSignals(contactId?: string): Promise<Signal[]>;
  saveSignal(signal: Signal): Promise<Signal>;

  /**
   * Pasa todo lo de `dropIds` a `keepId` y borra esos contactos.
   *
   * Es la única operación del Brain que destruye datos, así que vive acá y no
   * se arma con `saveContact` + borrados sueltos: en Postgres tiene que ser
   * una transacción. A medias dejaría interacciones apuntando a un contacto
   * que ya no existe, y eso no se ve hasta que alguien abre ese hilo.
   */
  mergeContacts(keepId: string, dropIds: string[]): Promise<void>;

  /** Borra todo — útil para re-correr la demo desde cero. */
  reset(): Promise<void>;
}

export const BRAIN_REPOSITORY = 'BrainRepository';
