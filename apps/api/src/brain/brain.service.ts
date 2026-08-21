import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { IdentityService, ResolveIdentityInput, ResolveIdentityResult } from './identity.service';
import {
  Contact,
  ContactListItem,
  Interaction,
  NlpearlCallContext,
  Signal,
  UnifiedContext,
} from './types';

/**
 * El core del prototipo: contexto unificado por contacto,
 * independiente del canal. Todo canal (voz, WhatsApp, SMS) lee y
 * escribe acá para continuar el mismo hilo e identidad.
 */
@Injectable()
export class BrainService {
  private readonly logger = new Logger(BrainService.name);

  constructor(
    @Inject(BRAIN_REPOSITORY) private readonly repo: BrainRepository,
    private readonly identity: IdentityService,
  ) {}

  resolveIdentity(input: ResolveIdentityInput): Promise<ResolveIdentityResult> {
    return this.identity.resolveIdentity(input);
  }

  async upsertContact(partial: Partial<Contact> & { id?: string }): Promise<Contact> {
    const existing = partial.id ? await this.repo.getContact(partial.id) : undefined;
    const contact: Contact = {
      id: existing?.id ?? partial.id ?? randomUUID(),
      displayName: partial.displayName ?? existing?.displayName,
      phones: partial.phones ?? existing?.phones ?? [],
      externalIds: { ...existing?.externalIds, ...partial.externalIds },
      kycmStatus: partial.kycmStatus ?? existing?.kycmStatus ?? 'unverified',
    };
    return this.repo.saveContact(contact);
  }

  /** Listado enriquecido para la consola: última interacción + promesa activa. */
  async listContacts(): Promise<ContactListItem[]> {
    const contacts = await this.repo.listContacts();
    const items: ContactListItem[] = [];
    for (const contact of contacts) {
      const interactions = await this.sortedInteractions(contact.id);
      const signals = await this.repo.listSignals(contact.id);
      const last = interactions[0];
      items.push({
        ...contact,
        lastInteraction: last
          ? { channel: last.channel, occurredAt: last.occurredAt, summary: last.summary, sentiment: last.sentiment }
          : undefined,
        activePromise: signals.find((s) => s.type === 'promise' && s.status === 'active'),
      });
    }
    return items;
  }

  /** Contexto unificado: contacto + timeline cross-channel + señales. */
  async getContext(query: { contactId?: string; phone?: string; externalId?: string }): Promise<UnifiedContext> {
    let contactId = query.contactId;
    if (!contactId) {
      const resolved = await this.identity.resolveIdentity({ phone: query.phone, externalId: query.externalId });
      contactId = resolved.contactId;
    }
    const contact = await this.repo.getContact(contactId);
    if (!contact) throw new NotFoundException(`Contacto ${contactId} no existe`);

    const recentInteractions = await this.sortedInteractions(contactId);
    const signals = await this.repo.listSignals(contactId);

    return {
      contact,
      recentInteractions,
      signals,
      sentimentTrend: this.sentimentTrend(recentInteractions),
    };
  }

  async appendInteraction(input: Omit<Interaction, 'id'> & { id?: string }): Promise<Interaction> {
    // Con id explícito (ej. `nlpearl:<callId>` del sync) el append es
    // idempotente: re-sincronizar el mismo rango no duplica el hilo.
    if (input.id) {
      const existing = (await this.repo.listInteractions(input.contactId)).find((i) => i.id === input.id);
      if (existing) return existing;
    }
    const interaction: Interaction = {
      id: input.id ?? randomUUID(),
      ...input,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    await this.repo.appendInteraction(interaction);
    this.logger.log(`Interacción ${interaction.channel}/${interaction.direction} → contacto ${interaction.contactId}`);
    return interaction;
  }

  async setSignal(input: Omit<Signal, 'id'> & { id?: string }): Promise<Signal> {
    const signal: Signal = { id: input.id ?? randomUUID(), ...input };
    return this.repo.saveSignal(signal);
  }

  getSignals(contactId: string): Promise<Signal[]> {
    return this.repo.listSignals(contactId);
  }

  listInteractions(contactId?: string): Promise<Interaction[]> {
    return this.repo.listInteractions(contactId);
  }

  /**
   * Punto de entrada del contexto de una llamada NL Pearl (webhook o bulk):
   * resuelve identidad, guarda la interacción de voz y actualiza señales
   * si la llamada capturó una promesa de pago.
   */
  async recordCallContext(call: NlpearlCallContext): Promise<Interaction> {
    const { contactId } = await this.identity.resolveIdentity({
      phone: call.phoneNumber,
      externalId: call.externalId,
      system: 'nlpearl',
    });

    // Si la llamada capturó el nombre (típico en entrantes de números nuevos),
    // se enriquece el contacto.
    const capturedName = call.collectedInfo?.['contactName'];
    if (typeof capturedName === 'string' && capturedName) {
      const contact = await this.repo.getContact(contactId);
      if (contact && !contact.displayName) {
        contact.displayName = capturedName;
        await this.repo.saveContact(contact);
      }
    }

    const interaction = await this.appendInteraction({
      // Id determinista por llamada: webhook + sync pueden traer la misma
      // llamada y debe quedar una sola interacción.
      id: call.callId ? `nlpearl:${call.callId}` : undefined,
      contactId,
      channel: 'voice',
      direction: call.direction ?? 'outbound',
      occurredAt: call.endedAt ?? call.startedAt ?? new Date().toISOString(),
      summary: call.summary,
      transcript: call.transcript,
      sentiment: call.sentiment,
      collectedInfo: call.collectedInfo,
      source: 'nlpearl',
    });

    // Si la llamada capturó una promesa de pago, se refleja como señal activa.
    // Si ya había una promesa activa, se actualiza (no se duplica).
    const promised = call.collectedInfo?.['promiseAmount'];
    if (promised !== undefined) {
      const existing = (await this.repo.listSignals(contactId)).find(
        (s) => s.type === 'promise' && s.status === 'active',
      );
      await this.setSignal({
        id: existing?.id,
        contactId,
        type: 'promise',
        amount: Number(promised),
        dueDate: (call.collectedInfo?.['promiseDate'] as string) ?? undefined,
        status: 'active',
        text: 'Promesa capturada en llamada de voz',
      });
    }
    return interaction;
  }

  /**
   * Sugerencia de seguimiento determinista: usa la última promesa activa
   * y el último resumen. // Hook opcional: reemplazar por un LLM.
   */
  async suggestFollowup(contactId: string, channel: 'whatsapp' | 'sms'): Promise<string> {
    const ctx = await this.getContext({ contactId });
    const name = ctx.contact.displayName ?? 'Hola';
    const promise = ctx.signals.find((s) => s.type === 'promise' && s.status === 'active');
    const lastVoice = ctx.recentInteractions.find((i) => i.channel === 'voice');

    const parts: string[] = [`${name}, gracias por conversar con nosotros.`];
    if (lastVoice?.summary) parts.push(`Resumen: ${lastVoice.summary}`);
    if (promise?.amount) {
      const due = promise.dueDate ? ` antes del ${promise.dueDate}` : '';
      parts.push(`Confirmamos tu compromiso de pago por ${promise.amount}${due}.`);
    }
    parts.push(channel === 'whatsapp' ? 'Cualquier consulta, respondé este WhatsApp.' : 'Respondé SMS para más info.');
    return parts.join(' ');
  }

  /** Tendencia simple de sentimiento sobre las últimas 3 interacciones. */
  private sentimentTrend(interactions: Interaction[]): string | undefined {
    const scored: number[] = interactions
      .filter((i) => i.sentiment)
      .slice(0, 3)
      .map((i) => (i.sentiment === 'positive' ? 1 : i.sentiment === 'negative' ? -1 : 0));
    if (!scored.length) return undefined;
    const avg = scored.reduce((a, b) => a + b, 0) / scored.length;
    return avg > 0.3 ? 'mejorando' : avg < -0.3 ? 'empeorando' : 'estable';
  }

  /** Interacciones cross-channel ordenadas: la más reciente primero. */
  private async sortedInteractions(contactId: string): Promise<Interaction[]> {
    const list = await this.repo.listInteractions(contactId);
    return list.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }
}
