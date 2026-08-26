import { AtencionService } from '../shared/atencion.service';
import { SettingsService } from '../shared/settings.service';
import { BrainService } from './brain.service';
import { BrainRepository } from './brain.repository';
import { Contact, Interaction, Signal } from './types';
import { IdentityService } from './identity.service';
import { UnificacionService } from './unificacion.service';

/**
 * Un solo hilo por número.
 *
 * Los duplicados los dejó el emparejado por texto exacto: hasta que se comparó
 * por dígitos, "+504 9761-6546" y "50497616546" eran dos personas. Partían la
 * conversación en dos, con la mitad de los mensajes en cada mitad, y el
 * operador tomaba una mientras las respuestas del ciudadano caían en la otra.
 */

/** Repositorio en memoria: solo lo que la unificación toca. */
function repo(contacts: Contact[], interactions: Interaction[] = [], signals: Signal[] = []) {
  const porId = new Map(contacts.map((c) => [c.id, c]));
  return {
    listContacts: async () => [...porId.values()],
    listInteractions: async () => interactions,
    listSignals: async () => signals,
    saveContact: async (c: Contact) => {
      porId.set(c.id, c);
      return c;
    },
    mergeContacts: async (keepId: string, dropIds: string[]) => {
      const fuera = new Set(dropIds);
      for (const i of interactions) if (fuera.has(i.contactId)) i.contactId = keepId;
      for (const s of signals) if (fuera.has(s.contactId)) s.contactId = keepId;
      for (const id of fuera) porId.delete(id);
    },
    __contactos: porId,
  };
}

const interaccion = (id: string, contactId: string): Interaction =>
  ({ id, contactId, channel: 'whatsapp', direction: 'inbound', occurredAt: '2026-08-26T10:00:00.000Z' }) as Interaction;

function servicio(r: ReturnType<typeof repo>, atencion: Record<string, string | null> = {}) {
  const brain = new BrainService(r as unknown as BrainRepository, {} as IdentityService);
  const tomados = { ...atencion };
  const atencionFalsa = {
    de: async (id: string) => ({ operador: tomados[id] ?? null }),
    tomar: async (id: string, operador: string) => {
      tomados[id] = operador;
      return { operador };
    },
  } as unknown as AtencionService;
  const settings = {
    get: async () => undefined,
    set: async (_k: string, v: unknown) => v,
  } as unknown as SettingsService;

  return { service: new UnificacionService(brain, atencionFalsa, settings), tomados };
}

describe('UnificacionService', () => {
  it('funde los contactos del mismo número aunque el formato difiera', async () => {
    const r = repo(
      [
        { id: 'viejo', phones: ['+504 9761-6546'], externalIds: {}, kycmStatus: 'unverified' },
        { id: 'nuevo', phones: ['50497616546'], externalIds: {}, kycmStatus: 'unverified' },
      ],
      [interaccion('i1', 'viejo'), interaccion('i2', 'viejo'), interaccion('i3', 'nuevo')],
    );
    const { service } = servicio(r);

    const hechas = await service.ahora();

    // Gana el que MÁS interacciones tiene: es el que arrastra la conversación.
    expect(hechas).toEqual([{ keepId: 'viejo', dropIds: ['nuevo'] }]);
    expect([...r.__contactos.keys()]).toEqual(['viejo']);
    // Y no se pierde ningún mensaje por el camino.
    expect((await r.listInteractions()).every((i) => i.contactId === 'viejo')).toBe(true);
  });

  it('el hilo conserva a su dueño aunque el tomado sea el que desaparece', async () => {
    /*
     * "Quién atiende" se guarda por contactId y vive FUERA del Brain, así que
     * la fusión no lo mueve sola. Sin trasladarlo, el hilo resultante quedaba
     * sin operador y las respuestas del ciudadano volvían a rebotar con
     * "nadie tomó esta conversación" — el mismo síntoma que se venía de
     * arreglar.
     */
    const r = repo(
      [
        { id: 'gordo', phones: ['+50497616546'], externalIds: {}, kycmStatus: 'unverified' },
        { id: 'flaco', phones: ['50497616546'], externalIds: {}, kycmStatus: 'unverified' },
      ],
      [interaccion('i1', 'gordo'), interaccion('i2', 'gordo')],
    );
    const { service, tomados } = servicio(r, { flaco: 'Jorge Murcia' });

    await service.ahora();

    expect(tomados['gordo']).toBe('Jorge Murcia');
  });

  it('no le pisa el dueño al que sobrevive si ya estaba tomado', async () => {
    const r = repo(
      [
        { id: 'gordo', phones: ['+50497616546'], externalIds: {}, kycmStatus: 'unverified' },
        { id: 'flaco', phones: ['50497616546'], externalIds: {}, kycmStatus: 'unverified' },
      ],
      [interaccion('i1', 'gordo')],
    );
    const { service, tomados } = servicio(r, { gordo: 'Ana Chavarría', flaco: 'Jorge Murcia' });

    await service.ahora();

    expect(tomados['gordo']).toBe('Ana Chavarría');
  });

  it('el superviviente se queda con el nombre y los teléfonos de todos', async () => {
    const r = repo(
      [
        { id: 'gordo', phones: ['+50497616546'], externalIds: { nlpearl: 'a' }, kycmStatus: 'unverified' },
        {
          id: 'flaco',
          displayName: 'Jorge Murcia',
          phones: ['50497616546', '+50433030235'],
          externalIds: { hubspot: 'b' },
          kycmStatus: 'unverified',
        },
      ],
      [interaccion('i1', 'gordo')],
    );
    const { service } = servicio(r);

    await service.ahora();

    const keep = r.__contactos.get('gordo')!;
    // El duplicado suele ser justo el que alcanzó a aprender el nombre.
    expect(keep.displayName).toBe('Jorge Murcia');
    expect(keep.phones).toEqual(['+50497616546', '50497616546', '+50433030235']);
    expect(keep.externalIds).toEqual({ nlpearl: 'a', hubspot: 'b' });
  });

  it('no toca nada cuando cada número tiene un solo contacto', async () => {
    const r = repo([
      { id: 'a', phones: ['+50497616546'], externalIds: {}, kycmStatus: 'unverified' },
      { id: 'b', phones: ['+50433030235'], externalIds: {}, kycmStatus: 'unverified' },
    ]);
    const { service } = servicio(r);

    expect(await service.ahora()).toEqual([]);
    expect([...r.__contactos.keys()]).toEqual(['a', 'b']);
  });

  it('es idempotente: correrla dos veces no cambia nada la segunda', async () => {
    const r = repo(
      [
        { id: 'gordo', phones: ['+50497616546'], externalIds: {}, kycmStatus: 'unverified' },
        { id: 'flaco', phones: ['50497616546'], externalIds: {}, kycmStatus: 'unverified' },
      ],
      [interaccion('i1', 'gordo')],
    );
    const { service } = servicio(r);

    await service.ahora();
    expect(await service.ahora()).toEqual([]);
  });
});
