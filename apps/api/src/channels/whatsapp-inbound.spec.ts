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

  /**
   * @param operador  Quién atiende cada contacto del número. Es un mapa y no
   *                  un valor suelto porque el mismo teléfono puede tener
   *                  varios contactos, y el que importa es el TOMADO.
   * @param contactos Los contactos que comparten ese número.
   */
  function build({
    operador,
    contactos = ['c1'],
  }: {
    operador: Record<string, string | null>;
    contactos?: string[];
  }) {
    const guardadas: Array<Record<string, unknown>> = [];
    const bitacora: string[] = [];

    const brain = {
      // No crea: preguntar por un número no debe dar de alta a nadie.
      findAllByPhone: async () => contactos.map((id) => ({ id })),
      appendInteraction: async (i: Record<string, unknown>) => {
        guardadas.push(i);
        return i;
      },
    };
    const atencion = { de: async (id: string) => ({ operador: operador[id] ?? null }) };

    const service = new WhatsappInboundService(
      brain as unknown as BrainService,
      atencion as unknown as AtencionService,
      { push: (_o: string, texto: string) => bitacora.push(texto) } as unknown as WebhookLogService,
    );
    return { service, guardadas, bitacora };
  }

  it('la respuesta del ciudadano entra al hilo que un operador tomó', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

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
    const { service, guardadas, bitacora } = build({ operador: { c1: null } });

    await service.process(mensaje('Hola'), 'gupshup');

    expect(guardadas).toHaveLength(0);
    // El motivo, no solo el rechazo: lo resuelve el operador con un clic.
    expect(bitacora[0]).toContain('nadie tomó esa conversación');
  });

  it('un número desconocido no crea un contacto fantasma', async () => {
    const { service, guardadas, bitacora } = build({ operador: {}, contactos: [] });

    await service.process(mensaje('Número que nunca escribió'), 'gupshup');

    expect(guardadas).toHaveLength(0);
    /*
     * Y se distingue del caso de arriba. Los dos terminan en "no entra al
     * Brain", pero uno lo arregla el operador tomando el hilo y el otro es un
     * fallo de emparejado de teléfonos que hay que corregir en el código.
     */
    expect(bitacora[0]).toContain('no hay ninguna conversación con ese número');
  });

  it('con contactos duplicados del mismo número, entra al que está tomado', async () => {
    /*
     * El teléfono llegó a tener varios contactos: antes de emparejar por
     * dígitos, cada formato distinto daba de alta uno nuevo. La consulta
     * devolvía el primero, que no tiene por qué ser el que el operador tomó,
     * y el mensaje quedaba fuera con un rechazo que contradecía la pantalla:
     * la app mostraba el hilo tomado y la bitácora decía que nadie lo tomó.
     */
    const { service, guardadas } = build({
      operador: { duplicado: null, tomado: 'Jorge Murcia' },
      contactos: ['duplicado', 'tomado'],
    });

    await service.process(mensaje('Ya la tomé, respondeme acá'), 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'tomado' });
  });

  it('no duplica cuando el proveedor reintenta el mismo mensaje', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');
    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');

    expect(guardadas).toHaveLength(1);
  });

  it('un acuse de entrega no es un mensaje del ciudadano', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(
      { type: 'message-event', payload: { type: 'delivered', destination: TEL, payload: {} } },
      'gupshup',
    );

    expect(guardadas).toHaveLength(0);
  });
});
