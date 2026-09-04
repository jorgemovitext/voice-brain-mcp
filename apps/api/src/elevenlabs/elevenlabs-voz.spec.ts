import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { BrainService } from '../brain/brain.service';
import { SettingsService } from '../shared/settings.service';
import { ElevenLabsVozService } from './elevenlabs-voz.service';

/**
 * La voz iniciada desde nuestra app.
 *
 * Lo que importa fijar: que la llamada lleve el contexto del hilo, que se
 * recuerde de quién es la conversación ANTES de que empiece —o la
 * transcripción llegaría sin dónde ponerse— y que traerla dos veces no
 * duplique el chat.
 */
describe('ElevenLabsVozService', () => {
  const CONFIG: Record<string, string> = {
    ELEVENLABS_API_URL: 'https://api.elevenlabs.io',
    ELEVENLABS_API_KEY: 'key',
    ELEVENLABS_AGENT_ID: 'agent_1',
    ELEVENLABS_PHONE_NUMBER_ID: 'num_1',
  };

  function build({
    provider = 'twilio',
    transcript = [] as Array<{ role: string; message: string; time_in_call_secs: number }>,
    fallaLlamada = false,
    /** El número del otro lado, como lo manda el proveedor: sin "+". */
    externo = undefined as string | undefined,
    /** Números de la cuenta, para probar el id viejo que ya no existe. */
    numeros = undefined as Array<Record<string, unknown>> | undefined,
    /** Fue una llamada de teléfono pero el proveedor no mandó el número. */
    llamadaSinNumero = false,
    /** La conversación no tiene grabación disponible del lado del proveedor. */
    sinGrabacion = false,
    /** Páginas del listado de conversaciones del agente, en orden. */
    paginas = [] as Array<Array<Record<string, unknown>>>,
  } = {}) {
    const identificados: Array<Record<string, unknown>> = [];
    const guardadas: Array<Record<string, unknown>> = [];
    const settings = new Map<string, unknown>();
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    /** Detalles pedidos: sirve para ver de cuáles NO se pidió. */
    const detalles: string[] = [];
    /** Cursores con los que se pidió cada página del listado. */
    const cursores: Array<string | undefined> = [];
    /** Ids ya guardados: emula la idempotencia real del Brain. */
    const vistos = new Set<string>();

    const http = {
      get: (url: string, cfg?: { params?: Record<string, unknown> }) => {
        if (url.endsWith('/v1/convai/conversations')) {
          const cursor = cfg?.params?.['cursor'] as string | undefined;
          cursores.push(cursor);
          const i = cursor ? Number(cursor) : 0;
          return of({
            data: {
              conversations: paginas[i] ?? [],
              has_more: i + 1 < paginas.length,
              next_cursor: String(i + 1),
            },
          });
        }
        if (url.includes('/v1/convai/conversations/') && !url.endsWith('/audio')) {
          detalles.push(url.split('/').pop() as string);
        }
        if (url.endsWith('/audio')) {
          if (sinGrabacion) return throwError(() => ({ response: { status: 404, data: 'not found' } }));
          return of({
            data: Uint8Array.from([0x49, 0x44, 0x33]).buffer,
            headers: { 'content-type': 'audio/mpeg' },
          });
        }
        if (url.includes('/phone-numbers')) {
          return of({
            data: numeros ?? [
              { phone_number_id: 'num_1', provider, supports_outbound: true },
            ],
          });
        }
        return of({
          data: {
            status: 'done',
            transcript,
            metadata: {
              start_time_unix_secs: 1_700_000_000,
              ...(externo
                ? { phone_call: { direction: 'inbound', external_number: externo } }
                : llamadaSinNumero
                  ? { phone_call: { direction: 'inbound' } }
                  : {}),
            },
            analysis: { transcript_summary: 'El vecino reportó un derrumbe.' },
          },
        });
      },
      post: (url: string, body: Record<string, unknown>) => {
        posts.push({ url, body });
        if (fallaLlamada) return throwError(() => ({ response: { status: 402, data: 'sin créditos' } }));
        return of({ data: { success: true, conversation_id: 'conv_9' } });
      },
    };
    const brain = {
      getContext: async () => ({ contact: { displayName: 'María López', phones: ['+50497616546'] } }),
      resolveIdentity: async (i: Record<string, unknown>) => {
        identificados.push(i);
        return { contactId: 'c-por-telefono', created: false };
      },
      appendInteraction: async (i: Record<string, unknown>) => {
        const id = i['id'] as string | undefined;
        if (id) {
          if (vistos.has(id)) return undefined;
          vistos.add(id);
        }
        guardadas.push(i);
        return i;
      },
    };
    const set = {
      get: async (k: string) => settings.get(k),
      set: async (k: string, v: unknown) => {
        settings.set(k, v);
        return v;
      },
    };

    const service = new ElevenLabsVozService(
      http as unknown as HttpService,
      brain as unknown as BrainService,
      set as unknown as SettingsService,
      { get: (k: string, def?: unknown) => CONFIG[k] ?? def } as unknown as ConfigService,
    );
    return { service, guardadas, settings, posts, identificados, detalles, cursores };
  }

  it('llama con el contexto del hilo y recuerda de quién es la conversación', async () => {
    const { service, guardadas, settings, posts } = build();

    const r = await service.llamar('c1', 'Jorge Murcia');

    expect(r.ok).toBe(true);
    expect(r.conversationId).toBe('conv_9');
    // El agente atiende sabiendo con quién habla: eso es tener Brain propio.
    expect(posts[0].body['to_number']).toBe('+50497616546');
    expect(JSON.stringify(posts[0].body)).toContain('María López');
    /*
     * Y se apunta ANTES de que la llamada empiece: el webhook de cierre trae
     * el conversation_id pero no sabe nada de nuestro contacto, así que sin
     * esto la transcripción no tendría hilo donde caer.
     */
    expect(settings.get('llamada:conv_9')).toBe('c1');
    expect(guardadas[0]).toMatchObject({ channel: 'voice', direction: 'outbound' });
  });

  it('elige el endpoint según el proveedor del número, sin configurarlo aparte', async () => {
    const twilio = build({ provider: 'twilio' });
    await twilio.service.llamar('c1', 'Jorge');
    expect(twilio.posts[0].url).toContain('/twilio/outbound-call');

    const sip = build({ provider: 'sip_trunk' });
    await sip.service.llamar('c1', 'Jorge');
    expect(sip.posts[0].url).toContain('/sip-trunk/outbound-call');

    /*
     * Exotel es el que provee el número de Honduras de la cuenta real. Esto
     * era un booleano "¿es SIP?" que caía a Twilio para todo lo demás, así que
     * la llamada salía por el endpoint equivocado y nunca timbraba — y nada en
     * el código lo delataba.
     */
    const exotel = build({ provider: 'exotel' });
    await exotel.service.llamar('c1', 'Jorge');
    expect(exotel.posts[0].url).toContain('/exotel/outbound-call');
  });

  it('la transcripción entra turno por turno, con quién habló cada uno', async () => {
    const { service, guardadas, settings } = build({
      transcript: [
        { role: 'agent', message: '¿En qué le puedo ayudar?', time_in_call_secs: 1 },
        { role: 'user', message: 'Se cayó un talud en el Mirador', time_in_call_secs: 6 },
      ],
    });
    settings.set('llamada:conv_9', 'c1');

    const r = await service.traerTranscripcion('conv_9');

    expect(r.nuevos).toBe(2);
    expect(guardadas[0]).toMatchObject({ direction: 'outbound', handledBy: 'agente' });
    expect(guardadas[1]).toMatchObject({ direction: 'inbound', summary: 'Se cayó un talud en el Mirador' });
    // El resumen del análisis queda como nota, no como un mensaje más.
    expect(guardadas[2]).toMatchObject({ channel: 'note' });
  });

  it('cada turno se acuerda de qué llamada es y en qué segundo va', async () => {
    /*
     * Es lo único que hace reproducible el audio desde el chat: la burbuja no
     * tiene un archivo propio —hay UNA grabación por llamada— así que cada
     * turno guarda a qué conversación pertenece y a qué segundo saltar. Sin
     * esto el ▶ existiría igual, pero arrancaría siempre desde el principio.
     */
    const { service, guardadas, settings } = build({
      transcript: [
        { role: 'agent', message: '¿En qué le puedo ayudar?', time_in_call_secs: 1 },
        { role: 'user', message: 'Se cayó un talud en el Mirador', time_in_call_secs: 6 },
      ],
    });
    settings.set('llamada:conv_9', 'c1');

    await service.traerTranscripcion('conv_9');

    const voz = guardadas.filter((g) => g['channel'] === 'voice');
    expect(voz[0]['collectedInfo']).toEqual({ conversationId: 'conv_9', desdeSegundo: 1 });
    // El segundo, no el mismo: el salto es por turno, no por llamada.
    expect(voz[1]['collectedInfo']).toEqual({ conversationId: 'conv_9', desdeSegundo: 6 });
  });

  it('la grabación vuelve con su tipo, para servirla tal cual', async () => {
    const { service } = build();

    const audio = await service.audioDeLlamada('conv_9');

    expect(audio?.tipo).toBe('audio/mpeg');
    expect(Buffer.isBuffer(audio?.datos)).toBe(true);
    expect(audio?.datos).toHaveLength(3);
  });

  it('una llamada sin grabación devuelve nada, no revienta el hilo', async () => {
    // Las llamadas viejas, y las que el proveedor no grabó, no tienen audio.
    // El hilo tiene que abrir igual: el botón queda mudo, no roto.
    const { service } = build({ sinGrabacion: true });

    expect(await service.audioDeLlamada('conv_vieja')).toBeNull();
  });

  it('traerla dos veces no duplica el chat', async () => {
    const { service, guardadas, settings } = build({
      transcript: [{ role: 'user', message: 'Hola', time_in_call_secs: 1 }],
    });
    settings.set('llamada:conv_9', 'c1');

    await service.traerTranscripcion('conv_9');
    const segunda = await service.traerTranscripcion('conv_9');

    // El webhook y un reintento manual pueden llegar los dos: el id
    // determinista es lo que evita el hilo duplicado.
    expect(segunda.nuevos).toBe(0);
    expect(guardadas.filter((g) => g['channel'] === 'voice')).toHaveLength(1);
  });

  it('una llamada que NO iniciamos entra al hilo del número que llamó', async () => {
    /*
     * Antes se cortaba con "no sabemos de qué hilo es", así que toda llamada
     * que no saliera de nuestro botón —las entrantes, y las que se hacen desde
     * el panel del proveedor— se descartaba: no aparecía en Conversaciones ni
     * contaba en el tablero, aunque hubiera ocurrido de verdad.
     */
    const { service, guardadas, identificados, settings } = build({
      externo: '50497616546',
      transcript: [{ role: 'user', message: 'Hay un bache', time_in_call_secs: 1 }],
    });

    const r = await service.traerTranscripcion('conv_entrante');

    expect(r.nuevos).toBe(1);
    // Se resuelve por teléfono, en E.164 aunque el proveedor lo mande sin "+".
    expect(identificados[0]).toMatchObject({ phone: '+50497616546' });
    expect(guardadas[0]).toMatchObject({ channel: 'voice', contactId: 'c-por-telefono' });
    // Y queda apuntado, para que el siguiente webhook no lo rebusque.
    expect(settings.get('llamada:conv_entrante')).toBe('c-por-telefono');
  });

  it('una llamada sin número al que asociarla lo dice, no la inventa', async () => {
    // Fue una llamada de verdad, pero sin el número no hay hilo posible: se
    // avisa en vez de colgarla del contacto equivocado.
    const { service } = build({ llamadaSinNumero: true });

    const r = await service.traerTranscripcion('conv_sin_numero');

    expect(r.nuevos).toBe(0);
    expect(r.aviso).toContain('no trae número');
  });

  it('si el número configurado ya no existe, usa el del agente', async () => {
    /*
     * Pasó en producción: se recreó el número y llamar empezó a dar
     * "Document with id phnum_… not found". El id de la variable de entorno
     * quedó viejo y nada más había cambiado.
     */
    const { service, posts } = build({
      numeros: [
        { phone_number_id: 'otro_id', provider: 'sip_trunk', supports_outbound: true, assigned_agent: { agent_id: 'a1' } },
      ],
    });

    await service.llamar('c1', 'Jorge Murcia');

    expect(posts[0].url).toContain('/sip-trunk/outbound-call');
    expect(posts[0].body['agent_phone_number_id']).toBe('otro_id');
  });

  it('una conversación del widget web no cuenta como llamada fallida', async () => {
    /*
     * Las pruebas desde el navegador no tienen `phone_call` en la metadata: no
     * hay teléfono al que colgarlas, y no es un fallo. Reportarlas como error
     * llenaba el reproceso de rojos por conversaciones que nunca debieron
     * entrar a un hilo — de 30 revisadas, 8 salían como falladas.
     */
    const { service } = build();

    const r = await service.traerTranscripcion('conv_del_widget');

    expect(r.nuevos).toBe(0);
    expect(r.aviso).toBeUndefined();
    expect(r.noEraLlamada).toBe(true);
  });

  it('el reproceso solo pide el detalle de las que son llamadas', async () => {
    /*
     * El mismo agente atiende WhatsApp: de 80 conversaciones, 68 eran turnos
     * de texto que YA están en su hilo. Pedir el detalle de todas es lo que
     * obligaba a cortar en las 30 más recientes, y el corte dejaba afuera
     * llamadas viejas de verdad.
     */
    const { service, detalles } = build({
      externo: '50497616546',
      transcript: [{ role: 'user', message: 'Hay un bache', time_in_call_secs: 1 }],
      paginas: [
        [
          { conversation_id: 'conv_llamada', direction: 'inbound', message_count: 3 },
          { conversation_id: 'conv_texto', message_count: 6 },
          { conversation_id: 'conv_texto_2', direction: null, message_count: 2 },
          // Un intento de llamada que nunca timbró: es telefónica, pero no hay
          // nada que meter al hilo.
          { conversation_id: 'conv_sin_timbrar', direction: 'outbound', message_count: 0 },
        ],
      ],
    });

    const r = await service.reprocesar();

    expect(detalles).toEqual(['conv_llamada']);
    expect(r.revisadas).toBe(4);
    expect(r.deTexto).toBe(3);
    expect(r.nuevos).toBe(1);
  });

  it('el reproceso pagina: no se queda con las últimas cien', async () => {
    const { service, detalles, cursores } = build({
      externo: '50497616546',
      transcript: [{ role: 'user', message: 'Se inundó la calle', time_in_call_secs: 2 }],
      paginas: [
        [{ conversation_id: 'conv_nueva', direction: 'inbound', message_count: 2 }],
        [{ conversation_id: 'conv_vieja', direction: 'inbound', message_count: 2 }],
      ],
    });

    await service.reprocesar();

    // La segunda página se pide con el cursor que devolvió la primera: sin eso
    // lo viejo queda tapado para siempre a medida que entra tráfico nuevo.
    expect(cursores).toEqual([undefined, '1']);
    expect(detalles).toContain('conv_vieja');
  });

  it('la reconciliación se frena sola y no barre en cada vuelta del sondeo', async () => {
    /*
     * La consola la pide desde cualquier pantalla cada pocos minutos: el freno
     * vive acá, no en el navegador, porque con dos pestañas abiertas el freno
     * del navegador no frena nada.
     */
    const { service, cursores } = build({
      paginas: [[{ conversation_id: 'conv_texto', message_count: 4 }]],
    });

    await service.reconciliar();
    expect(cursores).toHaveLength(1);

    await service.reconciliar();
    await service.reconciliar();
    expect(cursores).toHaveLength(1);
  });

  it('si ElevenLabs rechaza la llamada, el motivo vuelve accionable', async () => {
    const { service, guardadas } = build({ fallaLlamada: true });

    const r = await service.llamar('c1', 'Jorge Murcia');

    expect(r.ok).toBe(false);
    expect(r.aviso).toContain('402');
    expect(r.aviso).toContain('sin créditos');
    // No se anuncia en el hilo una llamada que nunca salió.
    expect(guardadas).toHaveLength(0);
  });
});
