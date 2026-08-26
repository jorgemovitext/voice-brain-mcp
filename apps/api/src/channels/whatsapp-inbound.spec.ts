import { BrainService } from '../brain/brain.service';
import { AtencionService } from '../shared/atencion.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';

/**
 * Qué entra al hilo y qué no.
 *
 * Los ciudadanos conversan con los agentes por el canal de NL Pearl, así que
 * meter TODO lo que llega por Gupshup crearía hilos duplicados y sin agente.
 * Pero cuando un operador toma una conversación, la app le escribe por
 * Gupshup y la respuesta vuelve por acá: dejarla solo en la bitácora hacía
 * que el operador escribiera a ciegas.
 */
describe('WhatsappInboundService', () => {
  const TEL = '+50497616546';

  /** Un mensaje entrante en el formato propio de Gupshup. */
  const mensaje = (texto: string, id = 'm1') => ({
    type: 'message',
    payload: {
      id,
      source: TEL,
      sender: { phone: TEL, name: 'Jorge' },
      payload: { text: texto },
    },
  });

  function build({ operador, contactoNuevo = false }: { operador: string | null; contactoNuevo?: boolean }) {
    const guardadas: Array<Record<string, unknown>> = [];
    const bitacora: string[] = [];

    const brain = {
      resolveIdentity: async () => ({ contactId: 'c1', created: contactoNuevo }),
      appendInteraction: async (i: Record<string, unknown>) => {
        guardadas.push(i);
        return i;
      },
    };
    const atencion = { de: async () => ({ operador }) };

    const service = new WhatsappInboundService(
      brain as unknown as BrainService,
      atencion as unknown as AtencionService,
      { push: (_o: string, texto: string) => bitacora.push(texto) } as unknown as WebhookLogService,
    );
    return { service, guardadas, bitacora };
  }

  it('la respuesta del ciudadano entra al hilo que un operador tomó', async () => {
    const { service, guardadas } = build({ operador: 'Jorge Murcia' });

    await service.process(mensaje('Sí, es en la esquina de la cancha'), 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({
      contactId: 'c1',
      channel: 'whatsapp',
      direction: 'inbound',
      summary: 'Sí, es en la esquina de la cancha',
    });
  });

  it('sin hilo tomado se queda en la bitácora: el agente atiende por NL Pearl', async () => {
    const { service, guardadas, bitacora } = build({ operador: null });

    await service.process(mensaje('Hola'), 'gupshup');

    expect(guardadas).toHaveLength(0);
    expect(bitacora[0]).toContain('sin hilo tomado');
  });

  it('un número desconocido no crea un hilo fantasma', async () => {
    const { service, guardadas } = build({ operador: 'Jorge Murcia', contactoNuevo: true });

    await service.process(mensaje('Número que nunca escribió'), 'gupshup');

    expect(guardadas).toHaveLength(0);
  });

  it('no duplica cuando el proveedor reintenta el mismo mensaje', async () => {
    const { service, guardadas } = build({ operador: 'Jorge Murcia' });

    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');
    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');

    expect(guardadas).toHaveLength(1);
  });

  it('un acuse de entrega no es un mensaje del ciudadano', async () => {
    const { service, guardadas } = build({ operador: 'Jorge Murcia' });

    await service.process(
      { type: 'message-event', payload: { type: 'delivered', destination: TEL, payload: {} } },
      'gupshup',
    );

    expect(guardadas).toHaveLength(0);
  });
});
