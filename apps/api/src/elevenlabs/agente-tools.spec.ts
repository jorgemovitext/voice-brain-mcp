import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort } from '../ports/channel.port';
import { AgenteToolsService } from './agente-tools.service';

/**
 * Lo que el agente puede HACER, no solo decir.
 *
 * Lo que se fija acá: que cada acción quede en el hilo con su marca —para que
 * el operador la vea entre los mensajes y sepa en qué momento pasó— y que
 * nunca lance, porque un fallo del CRM no puede cortar la conversación con el
 * ciudadano.
 */
describe('AgenteToolsService', () => {
  function build({ crmOk = true, crmFalla = false }: { crmOk?: boolean; crmFalla?: boolean } = {}) {
    const anotadas: Array<Record<string, unknown>> = [];
    const enviados: Array<{ contactId: string; texto: string }> = [];

    const brain = {
      getContext: async () => ({
        contact: { displayName: 'María López', phones: ['+50497616546'] },
      }),
      resolveIdentity: async () => ({ contactId: 'cuadrilla', created: false }),
      appendInteraction: async (i: Record<string, unknown>) => {
        anotadas.push(i);
        return i;
      },
    };
    const hubspot = {
      get configured() {
        return crmOk;
      },
      crearTicket: async () => {
        if (crmFalla) throw new Error('HubSpot rechazó el ticket');
        return { id: '4417', descartadas: [] };
      },
    };
    const canal = {
      send: async (contactId: string, texto: string) => {
        enviados.push({ contactId, texto });
        return { delivered: true, providerId: 'p1' };
      },
    };

    const service = new AgenteToolsService(
      brain as unknown as BrainService,
      hubspot as unknown as HubspotClient,
      canal as unknown as ChannelPort,
    );
    return { service, anotadas, enviados };
  }

  const REPORTE = {
    tipo_problema: 'Derrumbe',
    ubicacion: 'Colonia Mirador del Pinar',
    descripcion: 'Se vino el talud sobre la calle',
  };

  it('registra el reporte, devuelve el folio y lo deja marcado en el hilo', async () => {
    const { service, anotadas } = build();

    const r = await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    expect(r.ok).toBe(true);
    // El folio vuelve al agente para que se lo diga al ciudadano.
    expect(r.mensaje).toContain('AMDC-4417');
    // Y queda EN EL HILO marcado como acción, que es lo que la consola dibuja.
    expect(anotadas).toHaveLength(1);
    expect(anotadas[0]).toMatchObject({ contactId: 'c1', channel: 'note' });
    expect(anotadas[0]['accion']).toMatchObject({ tipo: 'ticket', ok: true });
    expect(String((anotadas[0]['accion'] as { detalle: string }).detalle)).toContain('AMDC-4417');
  });

  it('avisa a la cuadrilla y lo deja marcado', async () => {
    const { service, anotadas, enviados } = build();

    const r = await service.ejecutar('c1', 'avisar_autoridad', {
      motivo: 'Derrumbe con riesgo de vida',
      ubicacion: 'Colonia Mirador del Pinar',
    });

    expect(r.ok).toBe(true);
    expect(enviados).toHaveLength(1);
    // El aviso lleva quién reporta y desde qué número: la cuadrilla sale a la
    // calle con eso.
    expect(enviados[0].texto).toContain('Colonia Mirador del Pinar');
    expect(enviados[0].texto).toContain('María López');
    expect(anotadas[0]['accion']).toMatchObject({ tipo: 'aviso', ok: true });
  });

  it('sin los datos obligatorios NO abre el ticket: le dice al agente qué falta', async () => {
    const { service, anotadas } = build();

    const r = await service.ejecutar('c1', 'registrar_reporte', { tipo_problema: 'Bache' });

    expect(r.ok).toBe(false);
    // Se le nombra lo que falta para que lo pregunte, en vez de abrir un
    // ticket inservible.
    expect(r.mensaje).toContain('la ubicación');
    expect(r.mensaje).toContain('la descripción');
    expect(anotadas).toHaveLength(0);
  });

  it('si el CRM falla, la conversación sigue y el fallo queda visible', async () => {
    const { service, anotadas } = build({ crmFalla: true });

    const r = await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    // No lanza: el agente recibe el motivo y puede decírselo al ciudadano.
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('HubSpot rechazó el ticket');
    // Y el intento fallido se ve en el hilo, no se esconde.
    expect(anotadas[0]['accion']).toMatchObject({ tipo: 'ticket', ok: false });
  });

  it('sin CRM conectado lo dice claro, sin inventar un folio', async () => {
    const { service, anotadas } = build({ crmOk: false });

    const r = await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    expect(r.ok).toBe(false);
    // Lo importante: NO se inventa un número de reporte que no existe.
    expect(r.mensaje).not.toContain('AMDC-');
    expect(anotadas[0]['accion']).toMatchObject({ ok: false });
  });

  it('una herramienta que no existe no rompe el turno', async () => {
    const { service } = build();

    const r = await service.ejecutar('c1', 'borrar_todo', {});

    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('No existe la herramienta');
  });
});
