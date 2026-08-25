import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { FlowLogService } from '../shared/flow-log.service';
import { NlpearlActivityStore } from './activity.store';
import { NlpearlClient } from './nlpearl.client';
import { PearlSyncService } from './pearl-sync.service';

/**
 * La conversación se puede pedir por id desde el primer avance: el
 * `conversationId` que manda el flujo ES el callId. Eso llena el chat en
 * vivo y cubre el aviso post-conversación de NL Pearl, que llega UNA vez y
 * sin reintentos.
 */
describe('PearlSyncService.rescatarConversacion', () => {
  /** Un ObjectId de NL Pearl: 24 hex. */
  const CALL_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

  function build() {
    const pedidos: string[] = [];
    const guardadas = new Map<string, unknown>();

    const client = {
      getCall: async (id: string) => {
        pedidos.push(id);
        return {
          id,
          pearlId: 'p1',
          from: '+50497616546',
          to: '+50488862775',
          direction: 'inbound',
          startTime: '2026-08-25T07:48:00.000Z',
          transcript: [
            { role: 3, content: 'Se derrumbó la ladera', startTime: 0 },
            { role: 2, content: 'Su reporte quedó registrado.', startTime: 30 },
          ],
        };
      },
    };

    const store = {
      recordActivity: async () => undefined,
      listPearls: async () => [
        { id: 'p1', name: 'Línea 100 AMDC Whatsapp', channel: 'whatsapp' as const },
      ],
    };

    const brain = {
      resolveIdentity: async () => ({ contactId: 'k1' }),
      getContext: async () => ({ contact: { displayName: 'Jorge' } }),
      upsertContact: async () => undefined,
      getInteraction: async (id: string) => guardadas.get(id),
      appendInteraction: async (input: { id?: string }) => {
        const inter = { ...input, id: input.id! };
        if (guardadas.has(inter.id)) return guardadas.get(inter.id);
        guardadas.set(inter.id, inter);
        return inter;
      },
    };

    const service = new PearlSyncService(
      client as unknown as NlpearlClient,
      store as unknown as NlpearlActivityStore,
      brain as unknown as BrainService,
      { push: () => undefined } as unknown as FlowLogService,
      { get: (_k: string, def?: unknown) => def } as unknown as ConfigService,
    );

    return { service, pedidos, guardadas };
  }

  it('pide la conversación por id y la ingiere', async () => {
    const { service, pedidos, guardadas } = build();

    const nuevas = await service.rescatarConversacion(CALL_ID, 'Jorge');

    expect(pedidos).toEqual([CALL_ID]);
    expect(nuevas).toBe(2);
    expect(guardadas.size).toBe(2);
  });

  it('no toca el API con ids que no son de NL Pearl', async () => {
    const { service, pedidos } = build();

    // El simulador y las conversaciones de prueba usan UUID: pedirlas
    // devolvería 400 y quemaría el intento.
    const nuevas = await service.rescatarConversacion('5383eb27-5059-4c30-9c16-bae7dc775d4c');

    expect(nuevas).toBe(0);
    expect(pedidos).toEqual([]);
  });

  it('no repite el pedido en cada sondeo de la consola', async () => {
    const { service, pedidos } = build();

    await service.rescatarConversacion(CALL_ID);
    await service.rescatarConversacion(CALL_ID);
    await service.rescatarConversacion(CALL_ID);

    expect(pedidos).toEqual([CALL_ID]);
  });
});
