import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { IdentityService, ResolveIdentityInput, ResolveIdentityResult } from './identity.service';
import { digitosDe, mismoTelefono } from './telefono';
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
  /**
   * Listado con la última interacción y la promesa activa de cada contacto.
   *
   * Tres consultas fijas, no 1+2N: antes pedía interacciones y señales POR
   * contacto, y como la consola sondea este endpoint seguido, con nueve
   * contactos eran ~19 consultas por llamada varias veces por segundo. Contra
   * el pool de 3 conexiones de Neon eso saturaba y la vista de conversación
   * empezaba a fallar con "no se encontró".
   */
  /**
   * El contacto de un teléfono, o undefined. NO lo crea.
   *
   * `resolveIdentity` da de alta al contacto cuando no existe, que es lo
   * correcto para una conversación entrante de verdad. Pero para PREGUNTAR
   * —"¿este número ya tiene hilo?"— crear es justo lo que no se quiere: un
   * webhook de un número desconocido dejaba un contacto fantasma en la lista.
   */
  async findByPhone(phone: string): Promise<Contact | undefined> {
    return this.repo.findContactByPhone(phone);
  }

  /**
   * TODOS los contactos de ese número, no el primero.
   *
   * El mismo teléfono llegó a tener varios contactos: antes de emparejar por
   * dígitos, cada formato distinto ("+504 9761-6546", "50497616546") daba de
   * alta uno nuevo. `findContactByPhone` devuelve uno solo, y cuál sea es
   * cuestión de suerte — así que un mensaje entrante podía resolver a un
   * duplicado mientras el operador tenía tomado el otro, y quedaba fuera del
   * hilo con un "nadie tomó esta conversación" que contradecía la pantalla.
   */
  async findAllByPhone(phone: string): Promise<Contact[]> {
    const todos = await this.repo.listContacts();
    return todos.filter((c) => (c.phones ?? []).some((p) => mismoTelefono(p, phone)));
  }

  /**
   * Un contacto por número: fusiona los duplicados que dejó el emparejado por
   * texto exacto ("+504 9761-6546" y "50497616546" eran dos personas).
   *
   * Se conserva el que MÁS interacciones tiene, no el más viejo: es el que
   * arrastra la conversación de verdad, y mover pocas hacia muchas deja menos
   * expuesto si algo sale mal a mitad. El que sobrevive se queda con la unión
   * de teléfonos y de externalIds, y con el nombre de quien lo tenga — un
   * duplicado suele ser justo el que no alcanzó a aprenderlo.
   *
   * Devuelve las fusiones hechas para que quien la llame decida qué más mover
   * (el estado de "quién atiende" no vive en el Brain).
   */
  async unificarPorTelefono(): Promise<Array<{ keepId: string; dropIds: string[] }>> {
    const contactos = await this.repo.listContacts();

    const porNumero = new Map<string, Contact[]>();
    for (const c of contactos) {
      // Por el PRIMER teléfono: es el que identifica al hilo. Agrupar por
      // cualquiera encadenaría contactos que solo comparten un secundario.
      const clave = digitosDe(c.phones?.[0]);
      if (!clave) continue;
      porNumero.set(clave, [...(porNumero.get(clave) ?? []), c]);
    }

    const interacciones = await this.repo.listInteractions();
    const cuantas = new Map<string, number>();
    for (const i of interacciones) cuantas.set(i.contactId, (cuantas.get(i.contactId) ?? 0) + 1);

    const hechas: Array<{ keepId: string; dropIds: string[] }> = [];
    for (const [numero, grupo] of porNumero) {
      if (grupo.length < 2) continue;

      const [keep, ...drop] = [...grupo].sort((a, b) => (cuantas.get(b.id) ?? 0) - (cuantas.get(a.id) ?? 0));
      await this.repo.saveContact({
        ...keep,
        displayName: keep.displayName ?? drop.find((d) => d.displayName)?.displayName,
        phones: [...new Set([...(keep.phones ?? []), ...drop.flatMap((d) => d.phones ?? [])])],
        externalIds: Object.assign({}, ...drop.map((d) => d.externalIds ?? {}), keep.externalIds ?? {}),
      });

      const dropIds = drop.map((d) => d.id);
      await this.repo.mergeContacts(keep.id, dropIds);
      this.logger.log(`Unificados ${grupo.length} contactos del número ${numero} en ${keep.id}`);
      hechas.push({ keepId: keep.id, dropIds });
    }
    return hechas;
  }

  async listContacts(): Promise<ContactListItem[]> {
    const [contacts, interacciones, señales] = await Promise.all([
      this.repo.listContacts(),
      this.repo.listInteractions(),
      this.repo.listSignals(),
    ]);

    const ultima = new Map<string, Interaction>();
    for (const i of interacciones) {
      const previa = ultima.get(i.contactId);
      if (!previa || i.occurredAt > previa.occurredAt) ultima.set(i.contactId, i);
    }
    const promesa = new Map<string, Signal>();
    for (const s of señales) {
      if (s.type === 'promise' && s.status === 'active') promesa.set(s.contactId, s);
    }

    return contacts.map((contact) => {
      const last = ultima.get(contact.id);
      return {
        ...contact,
        lastInteraction: last
          ? { channel: last.channel, occurredAt: last.occurredAt, summary: last.summary, sentiment: last.sentiment }
          : undefined,
        activePromise: promesa.get(contact.id),
      };
    });
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

  async appendInteraction(
    input: Omit<Interaction, 'id'> & { id?: string },
    /** Pisa la interacción existente en vez de respetarla (reingesta). */
    opciones?: { overwrite?: boolean },
  ): Promise<Interaction> {
    // Con id explícito (ej. `nlpearl:<callId>` del sync) el append es
    // idempotente: re-sincronizar el mismo rango no duplica el hilo.
    if (input.id && !opciones?.overwrite) {
      const existing = await this.repo.findInteraction(input.id);
      if (existing) return existing;
    }
    const interaction: Interaction = {
      id: input.id ?? randomUUID(),
      ...input,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    if (opciones?.overwrite) await this.repo.replaceInteraction(interaction);
    else await this.repo.appendInteraction(interaction);
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

  /** ¿Ya está ingerida esta interacción? La usa el sync para no reprocesar. */
  getInteraction(id: string): Promise<Interaction | undefined> {
    return this.repo.findInteraction(id);
  }

  /**
   * Nota interna del operador: queda en el timeline del hilo (canal `note`)
   * pero no sale por ningún canal. Los agentes conversan; el humano apunta.
   */
  addInternalNote(contactId: string, text: string, author?: string): Promise<Interaction> {
    return this.appendInteraction({
      contactId,
      channel: 'note',
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: text,
      source: 'own',
      collectedInfo: author ? { author } : undefined,
    });
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
