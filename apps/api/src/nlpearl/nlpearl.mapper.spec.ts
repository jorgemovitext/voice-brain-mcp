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
