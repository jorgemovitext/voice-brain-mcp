import { Test } from '@nestjs/testing';
import { BrainService } from './brain.service';
import { IdentityService } from './identity.service';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { Contact, Interaction, Signal } from './types';

/**
 * Smoke tests del Brain con un repositorio en memoria puro
 * (sin archivo JSON) para mantener los tests deterministas.
 */
class InMemoryRepo implements BrainRepository {
  contacts = new Map<string, Contact>();
  interactions: Interaction[] = [];
  signals: Signal[] = [];

  async listContacts() {
    return [...this.contacts.values()];
  }
  async getContact(id: string) {
    return this.contacts.get(id);
  }
  async findContactByPhone(phone: string) {
    return [...this.contacts.values()].find((c) => c.phones.includes(phone));
  }
  async findContactByExternalId(system: string, externalId: string) {
    return [...this.contacts.values()].find((c) => c.externalIds[system] === externalId);
  }
  async saveContact(contact: Contact) {
    this.contacts.set(contact.id, contact);
    return contact;
  }
  async listInteractions(contactId?: string) {
    return contactId ? this.interactions.filter((i) => i.contactId === contactId) : [...this.interactions];
  }
  async findInteraction(id: string) {
    return this.interactions.find((i) => i.id === id);
  }
  async appendInteraction(interaction: Interaction) {
    this.interactions.push(interaction);
    return interaction;
  }
  async replaceInteraction(interaction: Interaction) {
    const i = this.interactions.findIndex((x) => x.id === interaction.id);
    if (i >= 0) this.interactions[i] = interaction;
    else this.interactions.push(interaction);
    return interaction;
  }

  async listSignals(contactId: string) {
    return this.signals.filter((s) => s.contactId === contactId);
  }
  async saveSignal(signal: Signal) {
    const idx = this.signals.findIndex((s) => s.id === signal.id);
    if (idx >= 0) this.signals[idx] = signal;
    else this.signals.push(signal);
    return signal;
  }
  async mergeContacts(keepId: string, dropIds: string[]) {
    const fuera = new Set(dropIds);
    for (const i of this.interactions) if (fuera.has(i.contactId)) i.contactId = keepId;
    for (const s of this.signals) if (fuera.has(s.contactId)) s.contactId = keepId;
    for (const id of fuera) this.contacts.delete(id);
  }
  async reset() {
    this.contacts.clear();
    this.interactions = [];
    this.signals = [];
  }
}

describe('BrainService', () => {
  let brain: BrainService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [BrainService, IdentityService, { provide: BRAIN_REPOSITORY, useClass: InMemoryRepo }],
    }).compile();
    brain = moduleRef.get(BrainService);
  });

  describe('resolveIdentity', () => {
    it('crea un contacto nuevo si el teléfono no existe', async () => {
      const result = await brain.resolveIdentity({ phone: '+50588887777' });
      expect(result.created).toBe(true);
      expect(result.contactId).toBeTruthy();
    });

    it('reutiliza el mismo contactId para el mismo teléfono', async () => {
      const first = await brain.resolveIdentity({ phone: '+50588887777' });
      const second = await brain.resolveIdentity({ phone: '+50588887777' });
      expect(second.created).toBe(false);
      expect(second.contactId).toBe(first.contactId);
    });

    it('une por externalId cuando el contactId propio viaja como externalId', async () => {
      const contact = await brain.upsertContact({ displayName: 'Ana', phones: ['+50511112222'] });
      const resolved = await brain.resolveIdentity({ externalId: contact.id });
      expect(resolved.created).toBe(false);
      expect(resolved.contactId).toBe(contact.id);
    });
  });

  describe('recordCallContext', () => {
    it('normaliza la llamada como interacción de voz y captura la promesa como señal', async () => {
      const contact = await brain.upsertContact({ displayName: 'María', phones: ['+50588887777'] });

      const interaction = await brain.recordCallContext({
        callId: 'call_1',
        phoneNumber: '+50588887777',
        externalId: contact.id,
        endedAt: '2026-08-18T15:00:00.000Z',
        transcript: 'Agente: hola\nCliente: me comprometo a pagar',
        summary: 'Cliente confirmó promesa de pago por 1500.',
        sentiment: 'positive',
        collectedInfo: { promiseAmount: 1500, promiseDate: '2026-08-25' },
      });

      expect(interaction.contactId).toBe(contact.id);
      expect(interaction.channel).toBe('voice');
      expect(interaction.source).toBe('nlpearl');
      expect(interaction.sentiment).toBe('positive');

      const signals = await brain.getSignals(contact.id);
      const promise = signals.find((s) => s.type === 'promise');
      expect(promise?.amount).toBe(1500);
      expect(promise?.dueDate).toBe('2026-08-25');
      expect(promise?.status).toBe('active');
    });
  });

  describe('getContext', () => {
    it('ordena el timeline cross-channel de más reciente a más antiguo', async () => {
      const contact = await brain.upsertContact({ displayName: 'María', phones: ['+50588887777'] });

      await brain.appendInteraction({
        contactId: contact.id,
        channel: 'whatsapp',
        direction: 'inbound',
        occurredAt: '2026-08-16T10:00:00.000Z',
        summary: 'Mensaje viejo de WhatsApp',
      });
      await brain.appendInteraction({
        contactId: contact.id,
        channel: 'voice',
        direction: 'outbound',
        occurredAt: '2026-08-18T12:00:00.000Z',
        summary: 'Llamada reciente',
      });
      await brain.appendInteraction({
        contactId: contact.id,
        channel: 'sms',
        direction: 'outbound',
        occurredAt: '2026-08-17T09:00:00.000Z',
        summary: 'SMS intermedio',
      });

      const ctx = await brain.getContext({ contactId: contact.id });
      expect(ctx.recentInteractions.map((i) => i.channel)).toEqual(['voice', 'sms', 'whatsapp']);
      expect(ctx.contact.id).toBe(contact.id);
    });
  });
});
