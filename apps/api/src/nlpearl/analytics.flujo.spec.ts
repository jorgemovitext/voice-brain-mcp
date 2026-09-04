import { BrainService } from '../brain/brain.service';
import { Interaction } from '../brain/types';
import { HubspotClient } from '../hubspot/hubspot.client';
import { NlpearlActivityStore } from './activity.store';
import { AnalyticsService } from './analytics.service';

/**
 * El mapa de flujo del tablero: canal → problema → resultado.
 *
 * Lo que se fija acá es la UNIDAD que se cuenta. Se contaba un canal por
 * contacto —el del primer mensaje entrante—, y con eso el tablero mostraba
 * solo WhatsApp por más llamadas que hubiera: el vecino que escribió y además
 * llamó contaba entero como WhatsApp.
 */
describe('AnalyticsService · mapa de flujo', () => {
  const ahora = new Date().toISOString();

  function interaccion(p: Partial<Interaction>): Interaction {
    return {
      id: Math.random().toString(36).slice(2),
      contactId: 'c1',
      channel: 'whatsapp',
      direction: 'inbound',
      occurredAt: ahora,
      ...p,
    } as Interaction;
  }

  function build(interactions: Interaction[]) {
    const brain = {
      listContacts: async () => [{ id: 'c1', phones: ['+50497616546'] }],
      listInteractions: async () => interactions,
    };
    const store = { listActivity: async () => [] };
    const hubspot = { configured: false };

    return new AnalyticsService(
      brain as unknown as BrainService,
      store as unknown as NlpearlActivityStore,
      hubspot as unknown as HubspotClient,
    );
  }

  it('un contacto que escribió Y llamó aparece en los dos canales', async () => {
    const service = build([
      interaccion({ channel: 'whatsapp', direction: 'inbound', occurredAt: '2026-09-04T10:00:00.000Z' }),
      interaccion({ channel: 'whatsapp', direction: 'outbound', occurredAt: '2026-09-04T10:01:00.000Z' }),
      interaccion({ channel: 'voice', direction: 'inbound', occurredAt: '2026-09-04T11:00:00.000Z' }),
    ]);

    const { flujo } = await service.resumen(30);

    /*
     * Dos aristas, una por canal. Antes salía UNA sola —whatsapp— porque el
     * canal se decidía por el primer entrante del contacto, y la llamada
     * desaparecía dentro de ese mismo conteo.
     */
    expect(flujo.map((f) => f.canal).sort()).toEqual(['voice', 'whatsapp']);
    expect(flujo.reduce((t, f) => t + f.total, 0)).toBe(2);
  });

  it('el "en espera" es del canal, no del contacto', async () => {
    // Se le contestó el WhatsApp, pero la llamada quedó sin devolver: el mapa
    // tiene que poder mostrar las dos cosas a la vez.
    const service = build([
      interaccion({ channel: 'whatsapp', direction: 'inbound', occurredAt: '2026-09-04T10:00:00.000Z' }),
      interaccion({ channel: 'whatsapp', direction: 'outbound', occurredAt: '2026-09-04T10:01:00.000Z' }),
      interaccion({ channel: 'voice', direction: 'inbound', occurredAt: '2026-09-04T11:00:00.000Z' }),
    ]);

    const { flujo } = await service.resumen(30);

    expect(flujo.find((f) => f.canal === 'whatsapp')?.resultado).toBe('atendida');
    expect(flujo.find((f) => f.canal === 'voice')?.resultado).toBe('esperando');
  });

  it('las notas internas no son un canal del mapa', async () => {
    const service = build([
      interaccion({ channel: 'whatsapp', direction: 'inbound' }),
      interaccion({ channel: 'note', direction: 'outbound' }),
    ]);

    const { flujo } = await service.resumen(30);

    expect(flujo.map((f) => f.canal)).toEqual(['whatsapp']);
  });
});
