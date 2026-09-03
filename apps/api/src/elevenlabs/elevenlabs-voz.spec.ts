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
  } = {}) {
    const guardadas: Array<Record<string, unknown>> = [];
    const settings = new Map<string, unknown>();
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    /** Ids ya guardados: emula la idempotencia real del Brain. */
    const vistos = new Set<string>();

    const http = {
      get: (url: string) => {
        if (url.includes('/phone-numbers')) {
          return of({ data: [{ phone_number_id: 'num_1', provider }] });
        }
        return of({
          data: {
            status: 'done',
            transcript,
            metadata: { start_time_unix_secs: 1_700_000_000 },
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
    return { service, guardadas, settings, posts };
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

  it('sin saber de qué hilo es, lo dice en vez de inventar', async () => {
    const { service } = build();

    const r = await service.traerTranscripcion('conv_desconocida');

    expect(r.nuevos).toBe(0);
    expect(r.aviso).toContain('No sabemos de qué hilo');
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
