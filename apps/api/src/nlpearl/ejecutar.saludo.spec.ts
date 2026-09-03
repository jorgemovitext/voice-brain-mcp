import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort } from '../ports/channel.port';
import { WebhookLogService } from '../shared/webhook-log.service';
import { NlpearlActivityStore } from './activity.store';
import { EjecutarService } from './ejecutar.service';

/**
 * El saludo salía de verdad pero no quedaba en el hilo: desde la consola era
 * indistinguible de un envío que falló, y el operador no tenía cómo saber qué
 * se mandó en su nombre.
 */
describe('EjecutarService.saludar', () => {
  const TEL = '+50497616546';
  /** Número emisor de Gupshup: es el dato que dice a qué chat responder. */
  const EMISOR = '50433030235';

  /**
   * @param entranteHaceMs Cuándo escribió el ciudadano por última vez. Es lo
   *   que decide si la ventana de 24 h está abierta. undefined = nunca
   *   escribió a NUESTRO número (el caso de NL Pearl).
   */
  function build(
    adaptador: Partial<ChannelPort> & Record<string, unknown>,
    entranteHaceMs?: number,
  ) {
    const interacciones: Array<Record<string, unknown>> = [];
    const bitacora: Array<{ ok: boolean; texto: string }> = [];

    const previas =
      entranteHaceMs === undefined
        ? []
        : [
            {
              direction: 'inbound',
              channel: 'whatsapp',
              occurredAt: new Date(Date.now() - entranteHaceMs).toISOString(),
            },
          ];

    const brain = {
      getContext: async () => ({ contact: { phones: [TEL] } }),
      listInteractions: async () => previas,
      appendInteraction: async (i: Record<string, unknown>) => {
        interacciones.push(i);
        return i;
      },
    };

    const service = new EjecutarService(
      brain as unknown as BrainService,
      {} as unknown as NlpearlActivityStore,
      {} as unknown as HubspotClient,
      { push: (_f: string, texto: string, ok: boolean) => bitacora.push({ ok, texto }) } as unknown as WebhookLogService,
      adaptador as unknown as ChannelPort,
      {
        get: (clave: string, def?: unknown) =>
          clave === 'GUPSHUP_SOURCE_NUMBER' ? EMISOR : def,
      } as unknown as ConfigService,
    );
    return { service, interacciones, bitacora };
  }

  it('manda la plantilla con el nombre de quien atiende y lo deja en el hilo', async () => {
    const enviados: Array<{ to: string; id: string; params: string[] }> = [];
    const { service, interacciones, bitacora } = build({
      templateSaludo: 'uuid-de-la-plantilla',
      sendTemplate: async (to: string, id: string, params: string[]) => {
        enviados.push({ to, id, params });
      },
    });

    const r = await service.saludar('c1', 'Jorge Murcia');

    expect(r.aviso).toBeUndefined();
    // Un solo parámetro: así quedó registrada la plantilla en Meta.
    expect(enviados).toEqual([{ to: TEL, id: 'uuid-de-la-plantilla', params: ['Jorge Murcia'] }]);
    expect(interacciones).toHaveLength(1);
    expect(interacciones[0]).toMatchObject({ contactId: 'c1', channel: 'whatsapp', direction: 'outbound' });
    expect(interacciones[0]['summary']).toContain('Jorge Murcia');
    expect(bitacora[0].ok).toBe(true);
    /*
     * La bitácora nombra el número EMISOR. El ciudadano tiene dos chats
     * abiertos con nosotros —el de la línea del agente y el nuestro— y solo lo
     * que responda a este último pasa por Gupshup y llega a la app. Sin ese
     * dato, "respondí y no llegó" es indistinguible de "respondiste en el
     * otro chat", que fue exactamente donde se atascó el diagnóstico.
     */
    expect(bitacora[0].texto).toContain(EMISOR);
  });

  it('sin el id de la plantilla avisa y no toca el hilo', async () => {
    const { service, interacciones, bitacora } = build({
      templateSaludo: '',
      sendTemplate: async () => undefined,
    });

    const r = await service.saludar('c1', 'Jorge Murcia');

    expect(r.aviso).toContain('GUPSHUP_TEMPLATE_SALUDO');
    expect(interacciones).toHaveLength(0);
    expect(bitacora[0].ok).toBe(false);
  });

  it('si el proveedor rechaza, el motivo vuelve y el hilo no miente', async () => {
    const { service, interacciones, bitacora } = build({
      templateSaludo: 'uuid-de-la-plantilla',
      sendTemplate: async () => {
        throw new Error('Template not found');
      },
    });

    const r = await service.saludar('c1', 'Jorge Murcia');

    expect(r.aviso).toContain('Template not found');
    // Nada en el hilo: no se anuncia un saludo que no salió.
    expect(interacciones).toHaveLength(0);
    expect(bitacora[0].ok).toBe(false);
  });

  it('con un proveedor sin plantillas (el stub) lo dice claro', async () => {
    const { service, interacciones } = build({ channel: 'whatsapp', send: async () => ({ delivered: true }) });

    const r = await service.saludar('c1', 'Jorge Murcia');

    expect(r.aviso).toContain('no manda plantillas');
    expect(interacciones).toHaveLength(0);
  });

  /*
   * El caso nuevo: desde que el agente atiende sobre NUESTRO número, el
   * ciudadano acaba de escribirnos y la ventana de 24 h está abierta. Mandar
   * una plantilla ahí se le cobra a la alcaldía y, peor, corta la
   * conversación con un saludo enlatado a mitad de camino.
   */
  it('con la ventana abierta se presenta en texto libre, sin gastar plantilla', async () => {
    const enviados: Array<{ to: string; id: string; params: string[] }> = [];
    const libres: Array<{ contactId: string; texto: string }> = [];
    const { service, interacciones, bitacora } = build(
      {
        templateSaludo: 'uuid-de-la-plantilla',
        sendTemplate: async (to: string, id: string, params: string[]) => {
          enviados.push({ to, id, params });
        },
        send: async (contactId: string, texto: string) => {
          libres.push({ contactId, texto });
          return { delivered: true, providerId: 'p1' };
        },
      },
      2 * 60 * 60_000, // escribió hace 2 h → ventana abierta
    );

    const r = await service.saludar('c1', 'Jorge Murcia');

    expect(r.aviso).toBeUndefined();
    // La plantilla NO se usa: eso es lo que se está evitando.
    expect(enviados).toHaveLength(0);
    // Y la presentación dice quién toma, para que no parezca que el agente
    // cambió de personalidad de golpe.
    expect(libres).toHaveLength(1);
    expect(libres[0].texto).toContain('Jorge Murcia');
    expect(interacciones[0]).toMatchObject({ direction: 'outbound', handledBy: 'Jorge Murcia' });
    expect(bitacora[0].texto).toContain('sin plantilla');
  });

  it('pasadas las 24 h vuelve a la plantilla: el texto libre ya no sale', async () => {
    const enviados: Array<{ to: string; id: string; params: string[] }> = [];
    const { service } = build(
      {
        templateSaludo: 'uuid-de-la-plantilla',
        sendTemplate: async (to: string, id: string, params: string[]) => {
          enviados.push({ to, id, params });
        },
        send: async () => ({ delivered: true }),
      },
      25 * 60 * 60_000, // escribió hace 25 h → ventana cerrada
    );

    await service.saludar('c1', 'Jorge Murcia');

    expect(enviados).toHaveLength(1);
  });
});
