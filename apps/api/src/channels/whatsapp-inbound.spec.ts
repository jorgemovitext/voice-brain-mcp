import { BrainService } from '../brain/brain.service';
import { AtencionService } from '../shared/atencion.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { ChannelPort } from '../ports/channel.port';

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
    respuestaAgente = null,
  }: {
    operador: Record<string, string | null>;
    contactos?: string[];
    /** Qué contesta el agente. null = motor apagado (el caso por defecto). */
    respuestaAgente?: string | null;
  }) {
    const guardadas: Array<Record<string, unknown>> = [];
    const bitacora: string[] = [];

    const enviados: Array<{ contactId: string; texto: string }> = [];
    const brain = {
      // No crea: preguntar por un número no debe dar de alta a nadie.
      findAllByPhone: async () => contactos.map((id) => ({ id })),
      // El agente SÍ da de alta, porque ahí sí hay una conversación real.
      resolveIdentity: async () => ({ contactId: 'nuevo', created: true }),
      appendInteraction: async (i: Record<string, unknown>) => {
        guardadas.push(i);
        return i;
      },
    };
    const agente = {
      configurado: () => respuestaAgente !== null,
      responderEnHilo: async () => respuestaAgente,
    };
    const canal = {
      send: async (contactId: string, texto: string) => {
        enviados.push({ contactId, texto });
        return { delivered: true, providerId: 'p1' };
      },
    };
    const atencion = { de: async (id: string) => ({ operador: operador[id] ?? null }) };

    const service = new WhatsappInboundService(
      brain as unknown as BrainService,
      atencion as unknown as AtencionService,
      { push: (_o: string, texto: string) => bitacora.push(texto) } as unknown as WebhookLogService,
      agente as unknown as ElevenLabsService,
      canal as unknown as ChannelPort,
    );
    return { service, guardadas, bitacora, enviados };
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

  it('una imagen entrante entra al hilo como adjunto, no se descarta', async () => {
    // Formato Meta (el que manda el Gupshup del usuario): media = {id, caption},
    // sin texto. Antes se tiraba por no tener `text` y no aparecía en el chat.
    const imagenMeta = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Jorge' } }],
                messages: [
                  { id: 'img1', from: TEL.slice(1), type: 'image', image: { id: 'MEDIA123', caption: 'la fuga' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(imagenMeta, 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'c1', attachment: 'foto', summary: 'la fuga' });
  });

  it('un audio de Gupshup v2 entra con su URL para poder escucharlo', async () => {
    const audio = {
      type: 'message',
      payload: {
        id: 'aud1',
        source: TEL,
        type: 'audio',
        sender: { phone: TEL, name: 'Jorge' },
        payload: { url: 'https://filemanager.gupshup.io/aud1.ogg', contentType: 'audio/ogg' },
      },
    };
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(audio, 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({
      attachment: 'audio',
      summary: 'Audio recibido',
      attachmentUrl: 'https://filemanager.gupshup.io/aud1.ogg',
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

  it('con el agente encendido, contesta él y la respuesta sale por nuestro canal', async () => {
    /*
     * El caso que justifica todo el cambio de motor: la conversación ocurre
     * sobre NUESTRO número, con nuestro contexto, y queda en el mismo hilo que
     * el operador puede tomar. Con NL Pearl el ciudadano estaba en su número y
     * nosotros mirábamos desde afuera.
     */
    const { service, guardadas, enviados } = build({
      operador: { c1: null },
      respuestaAgente: 'Claro, contame en qué te ayudo.',
    });

    await service.process(mensaje('Hola, quiero reportar un bache'), 'gupshup');

    // Los DOS turnos quedan en el hilo: lo que dijo y lo que le contestamos.
    expect(guardadas).toHaveLength(2);
    expect(guardadas[0]).toMatchObject({ direction: 'inbound', summary: 'Hola, quiero reportar un bache' });
    expect(guardadas[1]).toMatchObject({
      direction: 'outbound',
      summary: 'Claro, contame en qué te ayudo.',
      handledBy: 'agente',
    });
    // Y salió de verdad por el canal.
    expect(enviados).toEqual([{ contactId: 'nuevo', texto: 'Claro, contame en qué te ayudo.' }]);
  });

  it('el agente NO se mete en un hilo que ya tomó una persona', async () => {
    // Dos voces contestando a la vez es peor que ninguna.
    const { service, guardadas, enviados } = build({
      operador: { c1: 'Jorge Murcia' },
      respuestaAgente: 'Yo contesto',
    });

    await service.process(mensaje('Sí, es en la esquina'), 'gupshup');

    expect(enviados).toHaveLength(0);
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'c1', direction: 'inbound' });
  });

  it('si el agente no contesta, el mensaje igual queda para un humano', async () => {
    const { service, guardadas, enviados, bitacora } = build({
      operador: { c1: null },
      respuestaAgente: '',
    });

    await service.process(mensaje('¿Hay alguien?'), 'gupshup');

    // No se inventa una respuesta...
    expect(enviados).toHaveLength(0);
    // ...pero lo que dijo la persona no se pierde.
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ direction: 'inbound', summary: '¿Hay alguien?' });
    expect(bitacora[0]).toContain('queda para un humano');
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
