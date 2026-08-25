import { NlpearlCallApiView } from './nlpearl.client';
import { normalizarTranscript, toChatMessages } from './nlpearl.mapper';

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

  /**
   * La acción post-conversación del flujo manda `post_call_transcript`, que
   * llega como TEXTO formateado y no como el array del CallApiView.
   */
  describe('normalizarTranscript', () => {
    it('parsea el texto con etiquetas y respeta quién habló', () => {
      const t = normalizarTranscript(
        ['Cliente: Hay un bache en el bulevar', 'Agente: ¿En qué altura?', 'Cliente: Frente al estadio'].join('\n'),
      )!;

      expect(t.map((m) => m.content)).toEqual([
        'Hay un bache en el bulevar',
        '¿En qué altura?',
        'Frente al estadio',
      ]);
      // Y al pasar por toChatMessages, el agente cae de nuestro lado.
      expect(toChatMessages({ ...base, transcript: t }).map((m) => m.role)).toEqual([
        'customer',
        'agent',
        'customer',
      ]);
    });

    it('une las líneas sueltas al turno anterior', () => {
      const t = normalizarTranscript('Agente: Buenas.\n¿En qué le ayudo?\nCliente: Gracias')!;

      expect(t).toHaveLength(2);
      expect(t[0].content).toBe('Buenas.\n¿En qué le ayudo?');
    });

    /*
     * El caso que rompía en producción: NL Pearl manda la conversación entera
     * en UNA sola línea, con las etiquetas entre corchetes. Partir por saltos
     * de línea no encontraba ningún corte y el chat completo se pintaba como
     * una única burbuja gigante.
     */
    it('parte una conversación que viene entera en una sola línea', () => {
      const t = normalizarTranscript(
        '[User]: Hola [Pearl]: Hola, bienvenido a la Línea 100 de la AMDC. ' +
          '¿En qué le puedo servir? [User]: hay una crecida en el rio ' +
          '[Pearl]: ¿Hay alguien en peligro inmediato? [User]: gracias',
      )!;

      expect(t).toHaveLength(5);
      expect(t.map((m) => m.content)).toEqual([
        'Hola',
        'Hola, bienvenido a la Línea 100 de la AMDC. ¿En qué le puedo servir?',
        'hay una crecida en el rio',
        '¿Hay alguien en peligro inmediato?',
        'gracias',
      ]);
      expect(toChatMessages({ ...base, transcript: t }).map((m) => m.role)).toEqual([
        'customer',
        'agent',
        'customer',
        'agent',
        'customer',
      ]);
    });

    it('un array ya normalizado pasa tal cual', () => {
      const array = [{ role: 2, content: 'Hola' }];
      expect(normalizarTranscript(array)).toBe(array);
    });

    it('sin transcript devuelve undefined', () => {
      expect(normalizarTranscript(undefined)).toBeUndefined();
      expect(normalizarTranscript('   ')).toBeUndefined();
    });
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

  it('recorta espacios, y un turno en blanco es un adjunto, no basura', () => {
    const mensajes = toChatMessages({
      ...base,
      transcript: [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '  con espacios  ' },
      ],
    });
    expect(mensajes).toHaveLength(2);
    expect(mensajes[0].adjunto).toBe('adjunto');
    expect(mensajes[1].content).toBe('con espacios');
  });

  it('sin transcript no inventa mensajes', () => {
    expect(toChatMessages(base)).toEqual([]);
  });
});

/**
 * Turnos de adjunto: NL Pearl los entrega VACÍOS —`{role: 3, content: ""}`—
 * sin tipo ni URL. Descartarlos dejaba el hilo con agujeros: el agente
 * agradecía una foto que nunca aparecía en el chat.
 *
 * Los dos casos vienen de conversaciones reales de la Línea 100.
 */
describe('toChatMessages con adjuntos', () => {
  it('conserva el turno vacío y lo marca como foto por lo que contesta el agente', () => {
    const mensajes = toChatMessages({
      id: 'c1',
      startTime: '2026-08-25T07:48:00.000Z',
      transcript: [
        { role: 3, content: 'En la calle principal, obvio que lo obstruye' },
        { role: 2, content: 'Si puede hacerlo sin exponerse, envíeme una foto del hundimiento.' },
        { role: 3, content: '' },
        { role: 2, content: 'Recibí la foto, Yuni. ¿Cuál es tu correo electrónico?' },
      ],
    });

    expect(mensajes).toHaveLength(4);
    expect(mensajes[2]).toMatchObject({ role: 'customer', content: 'Foto recibida', adjunto: 'foto' });
    // Los turnos con texto no se marcan.
    expect(mensajes[0].adjunto).toBeUndefined();
  });

  it('lo marca como ubicación cuando el agente dice que ubicó el punto', () => {
    const mensajes = toChatMessages({
      id: 'c2',
      transcript: [
        { role: 2, content: 'Compartime la ubicación, el pin de WhatsApp o la dirección.' },
        { role: 3, content: '' },
        { role: 2, content: 'Ya ubiqué el punto en Barrio Los Jucos.' },
      ],
    });

    expect(mensajes[1]).toMatchObject({ content: 'Ubicación compartida', adjunto: 'ubicacion' });
  });

  it('no inventa el tipo cuando el agente no lo menciona', () => {
    const mensajes = toChatMessages({
      id: 'c3',
      transcript: [
        { role: 3, content: '' },
        { role: 2, content: 'Gracias. ¿Me confirma su nombre?' },
      ],
    });

    expect(mensajes[0]).toMatchObject({ content: 'Adjunto recibido', adjunto: 'adjunto' });
  });
});
