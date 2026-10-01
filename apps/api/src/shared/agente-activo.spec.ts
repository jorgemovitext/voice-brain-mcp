import { ConfigService } from '@nestjs/config';
import { AgenteActivoService, CLAVE_ACTIVO } from './agente-activo.service';
import { SettingsService } from './settings.service';

/**
 * Quién atiende, elegido desde la consola.
 *
 * Lo que se fija acá es la parte que no avisa cuando está mal. Cambiar de
 * agente no tira ninguna excepción: el nuevo se pone a contestar y suena bien.
 * Si se olvidara de mover el teléfono, o si el de voz quedara apuntando al
 * anterior, nadie se entera hasta que un vecino cuenta algo raro.
 */

function armar(opciones: { guardado?: string; env?: Record<string, string> } = {}) {
  const guardado: Record<string, unknown> = opciones.guardado
    ? { [CLAVE_ACTIVO]: opciones.guardado }
    : {};
  const settings = {
    get: async (k: string) => guardado[k],
    set: async (k: string, v: unknown) => {
      guardado[k] = v;
      return v;
    },
  } as unknown as SettingsService;

  const env: Record<string, string> = {
    ELEVENLABS_API_KEY: 'k',
    ELEVENLABS_API_URL: 'https://proveedor.test',
    ...opciones.env,
  };
  const config = { get: (c: string, d?: string) => env[c] ?? d ?? '' } as ConfigService;

  return { servicio: new AgenteActivoService(settings, config), guardado };
}

/** Un agente como lo devuelve el proveedor. */
function agente(
  opciones: Partial<{ texto: boolean; idioma: string; prompt: string; tools: string[]; saludo: string }> = {},
) {
  return {
    conversation_config: {
      conversation: { text_only: opciones.texto ?? false },
      agent: {
        language: opciones.idioma ?? 'es',
        first_message: opciones.saludo ?? 'Buenas, le atiende la Línea 100.',
        prompt: { prompt: opciones.prompt ?? 'Sos el agente.', tool_ids: opciones.tools ?? ['t1', 't2'] },
      },
    },
  };
}

describe('AgenteActivoService · quién atiende', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ok = (cuerpo: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(cuerpo) });

  /** Con los permisos de override YA puestos: poner() no tiene que tocarlos. */
  const CON_PERMISOS = {
    platform_settings: {
      overrides: {
        conversation_config_override: { conversation: { text_only: true }, agent: { first_message: true } },
      },
    },
  };

  it('sin nada elegido, atiende el del entorno', async () => {
    // Un despliegue limpio o una base vacía no pueden dejar la línea sin
    // quién conteste.
    const { servicio } = armar({ env: { ELEVENLABS_AGENT_ID: 'ag-viejo' } });

    await expect(servicio.id()).resolves.toBe('ag-viejo');
    await expect(servicio.origen()).resolves.toBe('entorno');
  });

  it('lo elegido en la consola le gana al entorno', async () => {
    const { servicio } = armar({ guardado: 'ag-nuevo', env: { ELEVENLABS_AGENT_ID: 'ag-viejo' } });

    await expect(servicio.id()).resolves.toBe('ag-nuevo');
    await expect(servicio.origen()).resolves.toBe('consola');
  });

  it('lo elegido en la consola también manda en las LLAMADAS', async () => {
    /*
     * El entorno tiene un segundo id para la voz. Si ganara, cambiar de agente
     * movería WhatsApp y dejaría el teléfono en el anterior: el estado partido
     * que no se nota hasta que alguien llama.
     */
    const { servicio } = armar({
      guardado: 'ag-nuevo',
      env: { ELEVENLABS_AGENT_ID: 'ag-viejo', ELEVENLABS_VOICE_AGENT_ID: 'ag-voz-viejo' },
    });

    await expect(servicio.idVoz()).resolves.toBe('ag-nuevo');
  });

  it('sin elección, la voz sigue usando su propio id del entorno', async () => {
    // El agente de WhatsApp lleva «solo texto», que le apaga el motor de voz:
    // por eso existía el segundo id, y quien no eligió nada sigue igual.
    const { servicio } = armar({
      env: { ELEVENLABS_AGENT_ID: 'ag-texto', ELEVENLABS_VOICE_AGENT_ID: 'ag-voz' },
    });

    await expect(servicio.idVoz()).resolves.toBe('ag-voz');
  });

  it('al poner uno nuevo, le mueve el teléfono', async () => {
    /*
     * Nuestra configuración decide a quién le hablamos nosotros; las llamadas
     * que ENTRAN las enruta el proveedor por la asignación del número. Sin
     * esto, los mensajes los contesta el nuevo y el teléfono sigue cayendo en
     * el viejo.
     */
    fetchMock
      .mockResolvedValueOnce(ok(CON_PERMISOS))
      .mockResolvedValueOnce(
        ok([
          { phone_number_id: 'ph1', phone_number: '+50400000000', assigned_agent: { agent_id: 'ag-viejo' } },
        ]),
      )
      .mockResolvedValueOnce(ok({}));

    const { servicio, guardado } = armar({ env: { ELEVENLABS_AGENT_ID: 'ag-viejo' } });
    const r = await servicio.poner('ag-nuevo');

    expect(guardado[CLAVE_ACTIVO]).toBe('ag-nuevo');
    expect(r.numeros).toEqual(['+50400000000']);
    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(JSON.parse(patch![1].body)).toEqual({ agent_id: 'ag-nuevo' });
  });

  it('no toca el número que ya era suyo', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(CON_PERMISOS))
      .mockResolvedValueOnce(
        ok([{ phone_number_id: 'ph1', phone_number: '+504', assigned_agent: { agent_id: 'ag-nuevo' } }]),
      );

    const { servicio } = armar();
    const r = await servicio.poner('ag-nuevo');

    expect(r.numeros).toEqual([]);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PATCH')).toBe(false);
  });

  it('si el teléfono no se puede mover, el cambio queda hecho pero se avisa', async () => {
    // Deshacerlo sería peor: el agente ya está guardado y contestando. Lo que
    // no se puede es callar que las llamadas siguen yendo al anterior.
    fetchMock
      .mockResolvedValueOnce(ok(CON_PERMISOS))
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'sin permiso' });

    const { servicio, guardado } = armar();
    const r = await servicio.poner('ag-nuevo');

    expect(guardado[CLAVE_ACTIVO]).toBe('ag-nuevo');
    expect(r.aviso).toMatch(/llamadas entrantes/i);
  });

  it('al poner, habilita los overrides que el motor de texto exige', async () => {
    /*
     * Cada turno de WhatsApp manda dos overrides, y el proveedor CORTA la
     * conversación si el agente no los permite — sin error y sin respuesta.
     * Movi nació por fuera de la consola sin el de `first_message`, y cada
     * mensaje moría en silencio. Ponerlo a atender ES dejarlo contestable.
     */
    fetchMock
      .mockResolvedValueOnce(ok({ platform_settings: {} }))
      .mockResolvedValueOnce(ok({})) // el PATCH de permisos
      .mockResolvedValueOnce(ok([])); // sin números que mover

    const { servicio } = armar();
    await servicio.poner('ag-nuevo');

    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
    const cuerpo = JSON.parse(patch![1].body);
    const cc = cuerpo.platform_settings.overrides.conversation_config_override;
    expect(cc.conversation.text_only).toBe(true);
    expect(cc.agent.first_message).toBe(true);
  });

  it('si ya tiene los permisos, no le manda ningún PATCH de permisos', async () => {
    // Mezclar sin motivo es arriesgar pisarle configuración puesta a mano.
    fetchMock.mockResolvedValueOnce(ok(CON_PERMISOS)).mockResolvedValueOnce(ok([]));

    const { servicio } = armar();
    await servicio.poner('ag-nuevo');

    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(0);
  });

  describe('a quién pertenece un hilo', () => {
    const hilo = (agentes: Array<string | undefined>, conAgente = true) =>
      agentes.map((a) => ({ handledBy: conAgente ? 'agente' : undefined, agente: a }));

    it('un hilo del activo se ve; uno de otro agente, no', async () => {
      const { servicio } = armar({ guardado: 'movi', env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      const filtro = await servicio.filtroDeHilos();

      expect(filtro(hilo(['movi']))).toBe(true);
      expect(filtro(hilo(['linea100']))).toBe(false);
    });

    it('lo histórico sin marca pertenece al agente del entorno', async () => {
      /*
       * Todo lo guardado antes de la atribución lo atendió el agente que
       * estaba en el entorno. Con el entorno activo se ve; con otro, no —
       * si se viera desde todos, cambiar de agente no cambiaría nada.
       */
      const sinEleccion = armar({ env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await sinEleccion.servicio.filtroDeHilos())(hilo([undefined]))).toBe(true);

      const conMovi = armar({ guardado: 'movi', env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await conMovi.servicio.filtroDeHilos())(hilo([undefined]))).toBe(false);
    });

    it('un contacto sin interacciones se ve desde cualquiera', async () => {
      // Recién creado por un operador: si no se viera, no habría desde dónde
      // escribirle.
      const { servicio } = armar({ guardado: 'movi' });
      expect((await servicio.filtroDeHilos())([])).toBe(true);
    });

    it('la marca manda aunque el mensaje no lo haya escrito un agente', async () => {
      /*
       * La marca dice EN QUÉ ESPACIO ocurrió, no quién habló: la pregunta del
       * vecino y el mensaje del operador también la llevan. La primera versión
       * miraba `handledBy === 'agente'`, y los hilos de la era NL Pearl —que
       * guardan el nombre del Pearl, no 'agente'— se colaban en CUALQUIER
       * bandeja: cambiar a Movi mostraba la Línea 100 igual.
       */
      const { servicio } = armar({ guardado: 'movi', env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      const filtro = await servicio.filtroDeHilos();

      // Mensajes marcados sin handledBy (vecino/operador en el espacio de Movi):
      expect(filtro(hilo(['movi'], false))).toBe(true);
      // Era NL Pearl: handledBy trae el nombre del Pearl y no hay marca.
      expect(filtro([{ handledBy: 'Pearl Línea 100', agente: undefined }])).toBe(false);
    });

    it('un hilo viejo que después atendió Movi se ve desde los DOS', async () => {
      /*
       * La historia sin marca es del entorno ADEMÁS de lo marcado: la primera
       * versión hacía desaparecer el hilo de la bandeja de la Línea 100 al
       * primer mensaje de Movi, como si su historia se la hubiera llevado.
       */
      const mixto = [{ handledBy: 'agente' }, { agente: 'movi' }];

      const movi = armar({ guardado: 'movi', env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await movi.servicio.filtroDeHilos())(mixto)).toBe(true);

      const linea = armar({ env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await linea.servicio.filtroDeHilos())(mixto)).toBe(true);
    });

    it('un hilo compartido se ve desde los dos agentes', async () => {
      // El mismo vecino pudo ser atendido por los dos en épocas distintas: el
      // hilo es del contacto, no de un agente, y cada vista lo muestra.
      const compartido = hilo(['movi', 'linea100']);

      const movi = armar({ guardado: 'movi', env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await movi.servicio.filtroDeHilos())(compartido)).toBe(true);

      const linea = armar({ env: { ELEVENLABS_AGENT_ID: 'linea100' } });
      expect((await linea.servicio.filtroDeHilos())(compartido)).toBe(true);
    });
  });

  describe('revisar antes de cambiar', () => {
    it('un agente completo no levanta reparos', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente()));

      const { servicio } = armar();
      await expect(servicio.revisar('ag-1')).resolves.toEqual([]);
    });

    it('avisa que está en otro idioma', async () => {
      // Pasó de verdad: un agente en inglés contestándole a un vecino de
      // Tegucigalpa. No falla nada, simplemente habla en el idioma equivocado.
      fetchMock.mockResolvedValueOnce(ok(agente({ idioma: 'en' })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ gravedad: 'aviso' });
      expect(r[0].texto).toContain('en');
    });

    it('avisa cuando no tiene NINGUNA herramienta, sin asumir cuáles debería tener', async () => {
      /*
       * La consola lleva agentes con trabajos distintos: exigirle a Movi las
       * herramientas de la Línea 100 lo marcaría roto estando bien. Lo único
       * que es un problema en cualquier agente es no poder ejecutar nada.
       */
      fetchMock.mockResolvedValueOnce(ok(agente({ tools: [] })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /ninguna herramienta/.test(x.texto))).toBe(true);
      expect(r.some((x) => /registrar_reporte/.test(x.texto))).toBe(false);
    });

    it('avisa cuando no tiene saludo: la llamada arranca en silencio', async () => {
      // Ya pasó, y el síntoma —"se corta sola"— no dice nada del saludo.
      fetchMock.mockResolvedValueOnce(ok(agente({ saludo: '' })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /saludo/.test(x.texto))).toBe(true);
    });

    it('sin saludo pero de solo texto NO avisa: en un chat habla primero la persona', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente({ saludo: '', texto: true })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /saludo/.test(x.texto))).toBe(false);
    });

    it('avisa que con «solo texto» las llamadas no levantan', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente({ texto: true })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /llamadas/.test(x.texto))).toBe(true);
    });

    it('un agente sin instrucciones se BLOQUEA, no se avisa', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente({ prompt: '  ' })));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => x.gravedad === 'bloqueo')).toBe(true);
    });

    it('un agente que ya no existe se bloquea y no sigue revisando', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });

      const r = await armar().servicio.revisar('ag-borrado');
      expect(r).toEqual([{ gravedad: 'bloqueo', texto: 'Ese agente ya no existe en la cuenta.' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
