import { NlpearlCallApiView } from './nlpearl.client';
import { toChatMessages } from './nlpearl.mapper';

/**
 * El transcript de una conversación de texto tiene que quedar como mensajes
 * sueltos y en orden: de eso depende que el hilo se vea como un chat y que se
 * distinga lo que escribió la persona de lo que contestó el agente.
 */
describe('toChatMessages', () => {
  const base: NlpearlCallApiView = { id: 'c1', startTime: '2026-08-22T10:00:00.000Z' };

  it('separa cada turno y traduce el rol', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [
        { role: 'user', content: 'Hay un bache en el bulevar', startTime: 0 },
        { role: 'assistant', content: 'Con gusto le ayudo, ¿en qué altura?', startTime: 30 },
      ],
    });

    expect(mensajes).toHaveLength(2);
    expect(mensajes[0]).toEqual({
      role: 'customer',
      content: 'Hay un bache en el bulevar',
      at: '2026-08-22T10:00:00.000Z',
    });
    // startTime son segundos desde el inicio de la conversación.
    expect(mensajes[1].role).toBe('agent');
    expect(mensajes[1].at).toBe('2026-08-22T10:00:30.000Z');
  });

  /**
   * El caso real: v2 manda `role` como enum numérico (2 = Pearl, 3 = Client,
   * 4 = PlatformUser). Tratándolo como texto, las respuestas del agente
   * caían del lado del cliente y el hilo se veía a una sola voz.
   */
  it('entiende el rol numérico de la API v2', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [
        { role: 3, content: 'Buenas, necesito ayuda', startTime: 0 },
        { role: 2, content: 'Claro, ¿en qué le colaboro?', startTime: 10 },
        { role: 4, content: 'Le escribe Jorge del equipo', startTime: 20 },
        { role: '2', content: 'Sigo yo desde acá', startTime: 30 },
      ],
    });

    expect(mensajes.map((m) => m.role)).toEqual(['customer', 'agent', 'agent', 'agent']);
  });

  it('ante un rol desconocido no le atribuye el mensaje al agente', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [{ role: 99, content: 'Origen no identificado' }],
    });

    expect(mensajes[0].role).toBe('customer');
  });

  it('sin startTime conserva el orden separando un segundo por mensaje', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [
        { role: 'user', content: 'uno' },
        { role: 'assistant', content: 'dos' },
        { role: 'user', content: 'tres' },
      ],
    });

    const tiempos = mensajes.map((m) => m.at);
    expect(tiempos).toEqual([...tiempos].sort());
    expect(new Set(tiempos).size).toBe(3);
  });

  it('acepta startTime como epoch en milisegundos', () => {
    const epoch = Date.UTC(2026, 7, 22, 11, 0, 0);
    const [mensaje] = toChatMessages({
      ...base,
      transcript: [{ role: 'user', content: 'hola', startTime: epoch }],
    });
    expect(mensaje.at).toBe(new Date(epoch).toISOString());
  });

  it('descarta mensajes vacíos y recorta espacios', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '  con espacios  ' },
      ],
    });
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].content).toBe('con espacios');
  });

  it('sin transcript no inventa mensajes', () => {
    expect(toChatMessages(base)).toEqual([]);
  });
});
