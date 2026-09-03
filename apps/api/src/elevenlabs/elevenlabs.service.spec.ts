import { BrainService } from '../brain/brain.service';
import { Interaction } from '../brain/types';
import { AgenteToolsService } from './agente-tools.service';
import { ElevenLabsClient } from './elevenlabs.client';
import { ElevenLabsService } from './elevenlabs.service';

/**
 * Dos fallas que se vieron en producción, en la primera conversación real:
 *
 * 1. El agente volvía a presentarse en el segundo mensaje, como si nunca
 *    hubiera hablado con la persona.
 * 2. Al ciudadano le llegaban las acotaciones de voz — "[pausa breve]",
 *    "[amable]" — que son para el sintetizador, no para leer.
 */
describe('ElevenLabsService', () => {
  /** Lo que el cliente recibió: sirve para ver QUÉ contexto se le mandó. */
  let ultimoContexto: string | undefined;

  function build({ interacciones = [] as Interaction[], respuesta = 'ok' }) {
    ultimoContexto = undefined;
    const brain = {
      getContext: async () => ({
        contact: { displayName: 'María López', phones: ['+50497616546'] },
        recentInteractions: interacciones,
      }),
    };
    const client = {
      configurado: () => true,
      responder: async (input: { contexto?: string }) => {
        ultimoContexto = input.contexto;
        return { texto: respuesta };
      },
    };
    const service = new ElevenLabsService(
      brain as unknown as BrainService,
      client as unknown as ElevenLabsClient,
      {} as unknown as AgenteToolsService,
    );
    return { service };
  }

  const turno = (min: number, direction: 'inbound' | 'outbound', summary: string): Interaction =>
    ({
      id: `i${min}`,
      contactId: 'c1',
      channel: 'whatsapp',
      direction,
      occurredAt: new Date(Date.UTC(2026, 8, 3, 17, min)).toISOString(),
      summary,
    }) as Interaction;

  it('le pasa el historial del más viejo al más nuevo, aunque llegue al revés', async () => {
    /*
     * `getContext` devuelve las interacciones de la MÁS NUEVA a la más vieja.
     * El código tomaba `slice(-12)` sobre eso —o sea las más viejas, y
     * encima invertidas—, así que el agente leía la charla al revés y volvía
     * a saludar. Se le pasa la lista desordenada a propósito.
     */
    const { service } = build({
      interacciones: [
        turno(44, 'inbound', 'Tengo dudas'),
        turno(40, 'outbound', '¡Buenas! Soy el asistente de la Línea 100.'),
      ],
    });

    await service.responderEnHilo('c1', '¿Me ayudás?');

    const lineas = (ultimoContexto ?? '').split('\n').filter((l) => l.startsWith('Ciudadano') || l.startsWith('Nosotros'));
    expect(lineas).toEqual([
      'Nosotros: ¡Buenas! Soy el asistente de la Línea 100.',
      'Ciudadano: Tengo dudas',
    ]);
  });

  it('conserva el contexto de conversaciones de OTRO canal', async () => {
    // El mismo hilo puede venir de voz y seguir por WhatsApp: es justo lo que
    // el Brain propio permite y NL Pearl no.
    const porVoz = { ...turno(10, 'inbound', 'Reporté un derrumbe por teléfono'), channel: 'voice' } as Interaction;
    const { service } = build({ interacciones: [turno(44, 'inbound', '¿Cómo va lo mío?'), porVoz] });

    await service.responderEnHilo('c1', '¿Cómo va lo mío?');

    expect(ultimoContexto).toContain('Reporté un derrumbe por teléfono');
    // Y en el orden correcto: primero la llamada, después el WhatsApp.
    expect((ultimoContexto ?? '').indexOf('derrumbe')).toBeLessThan((ultimoContexto ?? '').indexOf('¿Cómo va lo mío?'));
  });

  it('no le manda al ciudadano las acotaciones de voz', async () => {
    const { service } = build({
      respuesta: '[amable] ¡Hola! Qué bueno que escribís. [pausa breve] ¿En qué te puedo ayudar?',
    });

    const r = await service.responderEnHilo('c1', 'Hola');

    expect(r).toBe('¡Hola! Qué bueno que escribís. ¿En qué te puedo ayudar?');
  });

  it('no toca los corchetes que son parte del mensaje', async () => {
    // Una respuesta legítima puede usarlos; solo se quitan las acotaciones.
    const { service } = build({ respuesta: 'Tu reporte quedó con el folio [AMDC-4417]. ¿Algo más?' });

    const r = await service.responderEnHilo('c1', 'ok');

    expect(r).toContain('[AMDC-4417]');
  });

  it('si al limpiar no queda nada, se trata como silencio', async () => {
    // Una respuesta que era SOLO acotaciones no es una respuesta: mandarla
    // vacía por WhatsApp sería peor que no contestar.
    const { service } = build({ respuesta: '[pausa breve]' });

    expect(await service.responderEnHilo('c1', 'Hola')).toBeNull();
  });
});
