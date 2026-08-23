import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { Interaction } from '../brain/types';
import { FlowLogService } from '../shared/flow-log.service';
import { NlpearlActivityStore } from './activity.store';
import { NlpearlClient } from './nlpearl.client';
import { PearlSyncService } from './pearl-sync.service';

/**
 * La API de NL Pearl no permite releer las conversaciones de texto: el raw que
 * guardamos del webhook es la única copia. Por eso, cuando un mapeo estaba mal
 * —como el rol numérico que ponía las respuestas del agente del lado del
 * cliente— la reingesta desde ese raw es el único camino para corregir el
 * historial, y tiene que PISAR lo ya proyectado, no saltearlo.
 */
describe('PearlSyncService.reprocesarChats', () => {
  /** Como quedó guardado el chat con el mapeo viejo: todo del lado del cliente. */
  const yaGuardado: Interaction[] = [
    {
      id: 'nlpearl:chat_1:0',
      contactId: 'k1',
      channel: 'whatsapp',
      direction: 'inbound',
      occurredAt: '2026-08-23T17:00:00.000Z',
      summary: 'Hay un bache en el bulevar',
    },
    {
      id: 'nlpearl:chat_1:1',
      contactId: 'k1',
      channel: 'whatsapp',
      direction: 'inbound', // ← el agente, mal atribuido
      occurredAt: '2026-08-23T17:00:20.000Z',
      summary: 'Ya lo reporté a cuadrillas.',
    },
  ];

  function build() {
    const guardadas = new Map(yaGuardado.map((i) => [i.id, { ...i }]));

    const store = {
      listActivity: async () => [
        {
          id: 'chat_1',
          pearlId: 'p1',
          phone: '+50670599964',
          kind: 'chat' as const,
          occurredAt: '2026-08-23T17:00:00.000Z',
          raw: {
            id: 'chat_1',
            from: '+50670599964',
            to: '+50488862775',
            direction: 'inbound',
            startTime: '2026-08-23T17:00:00.000Z',
            transcript: [
              { role: 3, content: 'Hay un bache en el bulevar', startTime: 0 },
              { role: 2, content: 'Ya lo reporté a cuadrillas.', startTime: 20 },
            ],
          },
        },
      ],
      listPearls: async () => [
        { id: 'p1', name: 'Línea 100 AMDC Whatsapp', channel: 'whatsapp' as const },
      ],
    };

    const brain = {
      resolveIdentity: async () => ({ contactId: 'k1' }),
      getContext: async () => ({ contact: { displayName: 'Ana' } }),
      upsertContact: async () => undefined,
      getInteraction: async (id: string) => guardadas.get(id),
      appendInteraction: async (
        input: Omit<Interaction, 'id'> & { id?: string },
        opciones?: { overwrite?: boolean },
      ) => {
        const inter = { ...input, id: input.id! } as Interaction;
        if (!opciones?.overwrite && guardadas.has(inter.id)) return guardadas.get(inter.id)!;
        guardadas.set(inter.id, inter);
        return inter;
      },
    };

    const service = new PearlSyncService(
      {} as NlpearlClient,
      store as unknown as NlpearlActivityStore,
      brain as unknown as BrainService,
      { registrar: () => undefined } as unknown as FlowLogService,
      { get: (_k: string, def?: unknown) => def } as unknown as ConfigService,
    );

    return { service, guardadas };
  }

  it('corrige la dirección de los mensajes ya proyectados', async () => {
    const { service, guardadas } = build();

    const res = await service.reprocesarChats();

    expect(res).toEqual({ conversaciones: 1, mensajes: 2 });
    expect(guardadas.get('nlpearl:chat_1:0')!.direction).toBe('inbound');
    // El turno del agente (role 2) pasa a nuestro lado.
    expect(guardadas.get('nlpearl:chat_1:1')!.direction).toBe('outbound');
    // Y de paso queda anotado qué agente lo atendió.
    expect(guardadas.get('nlpearl:chat_1:1')!.handledBy).toBe('Línea 100 AMDC Whatsapp');
  });

  it('no duplica: reingerir dos veces deja los mismos mensajes', async () => {
    const { service, guardadas } = build();

    await service.reprocesarChats();
    await service.reprocesarChats();

    expect([...guardadas.keys()].sort()).toEqual(['nlpearl:chat_1:0', 'nlpearl:chat_1:1']);
  });
});
