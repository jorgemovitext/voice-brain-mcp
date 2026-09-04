import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort } from '../ports/channel.port';
import { SettingsService } from '../shared/settings.service';
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
  function build({
    crmOk = true,
    crmFalla = false,
    sinResponsables = false,
  }: { crmOk?: boolean; crmFalla?: boolean; sinResponsables?: boolean } = {}) {
    const anotadas: Array<Record<string, unknown>> = [];
    const enviados: Array<{ contactId: string; texto: string }> = [];
    const tareas: Array<Record<string, unknown>> = [];
    const asignadas: Array<Record<string, unknown>> = [];
    /** Tickets realmente abiertos: lo que cuenta al verificar la idempotencia. */
    const tickets: Array<Record<string, unknown>> = [];

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
        tickets.push({});
        return { id: '4417', descartadas: [] };
      },
      // Vacía cuando el token no puede leerlos: el cliente devuelve [] en vez
      // de lanzar, para que un permiso faltante no tumbe la herramienta.
      responsables: async () =>
        sinResponsables
          ? []
          : [
              { id: '77', email: 'obras@amdc.hn', firstName: 'Luis', lastName: 'Vallecillo' },
              { id: '88', email: 'agua@amdc.hn', firstName: 'Rosa', lastName: 'Díaz' },
            ],
      contactosPorTelefono: async () => ['c-crm-1'],
      crearTarea: async (input: Record<string, unknown>) => {
        tareas.push(input);
        return { id: 'T-9' };
      },
      asignarTarea: async (tareaId: string, ownerId: string, prioridad?: string) => {
        asignadas.push({ tareaId, ownerId, prioridad });
      },
    };
    const canal = {
      send: async (contactId: string, texto: string) => {
        enviados.push({ contactId, texto });
        return { delivered: true, providerId: 'p1' };
      },
    };

    // Guarda la tarea pendiente entre registrar y asignar: sin esto, asignar
    // crearía una segunda tarea para el mismo reporte.
    const guardado = new Map<string, unknown>();
    const settings = {
      get: async (k: string) => guardado.get(k),
      set: async (k: string, v: unknown) => {
        guardado.set(k, v);
        return v;
      },
    };

    const service = new AgenteToolsService(
      brain as unknown as BrainService,
      hubspot as unknown as HubspotClient,
      settings as unknown as SettingsService,
      canal as unknown as ChannelPort,
    );
    return { service, anotadas, enviados, tareas, asignadas, tickets };
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
    // Junto a la acción se anota la ficha del riel, así que se busca la acción
    // en vez de dar por hecho que es la única anotación del turno.
    const accion = anotadas.find((a) => a['accion']);
    expect(accion).toMatchObject({ contactId: 'c1', channel: 'note' });
    expect(accion!['accion']).toMatchObject({ tipo: 'ticket', ok: true });
    expect(String((accion!['accion'] as { detalle: string }).detalle)).toContain('AMDC-4417');
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

  it('asigna la tarea al responsable real del portal', async () => {
    const { service, anotadas, tareas } = build();

    const r = await service.ejecutar('c1', 'asignar_tarea', {
      titulo: 'Inspeccionar talud',
      responsable: 'Luis Vallecillo',
      prioridad: 'HIGH',
    });

    expect(r.ok).toBe(true);
    expect(tareas[0]).toMatchObject({ titulo: 'Inspeccionar talud', ownerId: '77', prioridad: 'HIGH' });
    // Colgada de la ficha del ciudadano, o nadie la encuentra desde ahí.
    expect(tareas[0]['contactoId']).toBe('c-crm-1');
    expect(anotadas[0]['accion']).toMatchObject({ tipo: 'ticket', ok: true });
  });

  it('con un responsable que no existe, devuelve los que sí — no asigna a cualquiera', async () => {
    // Una tarea en la bandeja equivocada es peor que una sin dueño: nadie la
    // ve y todos creen que está atendida.
    const { service, tareas } = build();

    const r = await service.ejecutar('c1', 'asignar_tarea', {
      titulo: 'Revisar fuga',
      responsable: 'Pedro Inexistente',
    });

    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('Luis Vallecillo');
    expect(r.mensaje).toContain('Rosa Díaz');
    expect(tareas).toHaveLength(0);
  });

  it('escalar a humano deja la marca que la consola convierte en aviso', async () => {
    /*
     * El agente venía PROMETIENDO una transferencia que no ocurría ("te paso
     * con un operador", "no colgués"). Ahora la promesa tiene mecanismo: el
     * hilo queda marcado y la consola muestra el pedido.
     */
    const { service, anotadas } = build();

    const r = await service.ejecutar('c1', 'escalar_a_humano', {
      motivo: 'Derrumbe con gente en riesgo',
      urgencia: 'alta',
    });

    expect(r.ok).toBe(true);
    expect(anotadas[0]['accion']).toMatchObject({ tipo: 'escalamiento', ok: true });
    // Y se le recuerda al agente que esto es un chat: pedirle a alguien que
    // "no cuelgue" en WhatsApp fue justo lo que pasó en producción.
    expect(r.mensaje).toContain('no una llamada');
  });

  it('la ficha guarda SOLO lo que vino en ese turno', async () => {
    /*
     * El parcial es lo que hace que el riel se vea crecer: si guardáramos la
     * ficha entera en cada llamada, todos los campos figurarían como recién
     * cambiados y el resaltado de la consola dejaría de significar algo.
     */
    const { service, anotadas } = build();

    const r = await service.ejecutar('c1', 'actualizar_ficha', {
      tipo_problema: 'Derrumbe',
      riesgo: 'alto',
    });

    expect(r.ok).toBe(true);
    expect(anotadas[0]['ficha']).toEqual({ tipo_problema: 'Derrumbe', riesgo: 'alto' });
    // Y no se le cuenta al ciudadano: es un panel interno.
    expect(r.mensaje).toContain('No se lo menciones');
  });

  it('la ficha descarta campos que el agente se inventó', async () => {
    // Un panel donde el modelo puede agregar filas deja de leerse de un vistazo.
    const { service, anotadas } = build();

    await service.ejecutar('c1', 'actualizar_ficha', {
      ubicacion: 'Colonia Mirador del Pinar',
      color_del_cielo: 'gris',
    });

    expect(anotadas[0]['ficha']).toEqual({ ubicacion: 'Colonia Mirador del Pinar' });
  });

  it('una ficha sin datos no se anota', async () => {
    const { service, anotadas } = build();

    const r = await service.ejecutar('c1', 'actualizar_ficha', { ubicacion: '   ' });

    expect(r.ok).toBe(false);
    expect(anotadas).toHaveLength(0);
  });

  it('registrar el reporte CREA la tarea, sin esperar a que el agente la pida', async () => {
    /*
     * Esto es lo que estaba roto en producción: no se creaban tareas en
     * HubSpot. Probado contra el agente real, registró el bache, le dijo al
     * ciudadano "lo trasladamos a la cuadrilla de bacheo" y no llamó
     * asignar_tarea — su propio plan decía asignarla. La misma promesa sin
     * mecanismo que ya habíamos visto con el escalamiento.
     */
    const { service, tareas } = build();

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    expect(tareas).toHaveLength(1);
    expect(String(tareas[0]['titulo'])).toContain('Derrumbe');
    expect(String(tareas[0]['titulo'])).toContain('Colonia Mirador del Pinar');
    // Nace sin dueño: acá nadie sabe a quién le toca. Verla y repartirla es
    // posible; que no exista, no.
    expect(tareas[0]['ownerId']).toBeUndefined();
  });

  it('asignar responsable le pone dueño a ESA tarea, no crea una segunda', async () => {
    // Dos tarjetas para el mismo bache, una sin nadie, es peor que la tarea
    // original sin dueño.
    const { service, tareas, asignadas } = build();

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);
    const r = await service.ejecutar('c1', 'asignar_tarea', {
      titulo: 'Inspeccionar talud',
      responsable: 'Luis Vallecillo',
      prioridad: 'HIGH',
    });

    expect(r.ok).toBe(true);
    expect(tareas).toHaveLength(1); // la del reporte, no una nueva
    expect(asignadas).toEqual([{ tareaId: 'T-9', ownerId: '77', prioridad: 'HIGH' }]);
  });

  it('sin responsables en el portal, corta en vez de mandar al agente a un bucle', async () => {
    /*
     * Pasó en producción: al token le faltaba `crm.objects.owners.read`, la
     * lectura devolvía 403 y la lista quedaba vacía. Los mensajes normales le
     * dicen al agente "elegí uno de estos: " —con la lista vacía— y vuelve a
     * llamar una y otra vez, gastando el turno del ciudadano.
     */
    const { service, anotadas } = build({ sinResponsables: true });

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);
    const r = await service.ejecutar('c1', 'asignar_tarea', { titulo: 'Reparar el bache' });

    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('No lo intentes de nuevo');
    // Y el operador ve por qué quedó sin dueño, en el hilo.
    expect(anotadas.some((a) => String((a['accion'] as { detalle?: string })?.detalle ?? '').includes('sin responsable'))).toBe(true);
  });

  it('asignar sin responsable NO duplica la tarea: devuelve la lista para elegir', async () => {
    /*
     * Probado contra el agente real: después de registrar llama asignar_tarea
     * SIN responsable, porque no tiene de dónde sacar la lista hasta que se la
     * damos. Sin este corte se creaba una segunda tarea para el mismo bache.
     */
    const { service, tareas } = build();

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);
    const r = await service.ejecutar('c1', 'asignar_tarea', { titulo: 'Reparar el bache' });

    expect(r.ok).toBe(false);
    expect(tareas).toHaveLength(1);
    expect(r.mensaje).toContain('Luis Vallecillo');
    expect(r.mensaje).toContain('Rosa Díaz');
  });

  it('si la tarea del reporte falla, el ciudadano igual se queda con su folio', async () => {
    // El ticket YA se abrió. Quedarse sin tarea es un problema del equipo;
    // tirar el turno por eso sería un problema del vecino.
    const { service, anotadas } = build();
    const falla = { ...REPORTE };

    const r = await service.ejecutar('c1', 'registrar_reporte', falla);

    expect(r.ok).toBe(true);
    expect(r.mensaje).toContain('AMDC-4417');
    expect(anotadas.some((a) => a['ficha'])).toBe(true);
  });

  it('registrar el MISMO reporte dos veces abre UN solo ticket', async () => {
    /*
     * El agente llama registrar_reporte dos veces en el mismo turno. Se
     * reprodujo desde el banco de pruebas con un único mensaje del ciudadano:
     * la respuesta traía la herramienta repetida. Sin esto son dos tickets para
     * el mismo bache, con dos folios, y el vecino se queda con uno mientras la
     * cuadrilla ve dos.
     */
    const { service, tickets } = build();

    const primera = await service.ejecutar('c1', 'registrar_reporte', REPORTE);
    const segunda = await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    expect(tickets).toHaveLength(1);
    // Y al agente se le devuelve el MISMO folio, para que no diga dos números.
    expect(primera.mensaje).toContain('AMDC-4417');
    expect(segunda.mensaje).toContain('AMDC-4417');
    expect(segunda.mensaje).toContain('no lo registres de nuevo');
  });

  it('un reporte DISTINTO del mismo vecino sí abre otro ticket', async () => {
    // La huella es tipo+ubicación: dos problemas de verdad no se pisan.
    const { service, tickets } = build();

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);
    await service.ejecutar('c1', 'registrar_reporte', {
      ...REPORTE,
      tipo_problema: 'Bache',
      ubicacion: 'Colonia Kennedy',
    });

    expect(tickets).toHaveLength(2);
  });

  it('avisar a la cuadrilla sube el riesgo de la ficha sin que el agente lo pida', async () => {
    /*
     * Contra el agente real, ante "hay una señora atrapada" avisó a la cuadrilla
     * pero NO tocó la ficha: el riesgo seguía en "medio" en la pantalla del
     * operador que decide si entra. Nadie manda una cuadrilla por un bache, así
     * que el riesgo alto se deduce del hecho.
     */
    const { service, anotadas } = build();

    await service.ejecutar('c1', 'avisar_autoridad', {
      motivo: 'Persona atrapada',
      ubicacion: 'Colonia Mirador del Pinar',
    });

    const fichas = anotadas.filter((a) => a['ficha']);
    expect(fichas).toHaveLength(1);
    expect(fichas[0]['ficha']).toMatchObject({ riesgo: 'alto', estado: 'cuadrilla avisada' });
  });

  it('registrar el reporte deja la ficha en "registrado" con los datos del reporte', async () => {
    const { service, anotadas } = build();

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    const ficha = anotadas.find((a) => a['ficha'])?.['ficha'];
    expect(ficha).toMatchObject({
      tipo_problema: 'Derrumbe',
      ubicacion: 'Colonia Mirador del Pinar',
      estado: 'registrado',
    });
  });

  it('si la acción falla, la ficha NO dice que se hizo', async () => {
    // Un panel que anuncia un ticket que no existe es peor que uno vacío.
    const { service, anotadas } = build({ crmFalla: true });

    await service.ejecutar('c1', 'registrar_reporte', REPORTE);

    expect(anotadas.filter((a) => a['ficha'])).toHaveLength(0);
  });

  it('una herramienta que no existe no rompe el turno', async () => {
    const { service } = build();

    const r = await service.ejecutar('c1', 'borrar_todo', {});

    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('No existe la herramienta');
  });
});
