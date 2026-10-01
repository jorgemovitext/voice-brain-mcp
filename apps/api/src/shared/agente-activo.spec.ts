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
function agente(opciones: Partial<{ texto: boolean; idioma: string; prompt: string; tools: string[] }> = {}) {
  return {
    conversation_config: {
      conversation: { text_only: opciones.texto ?? false },
      agent: {
        language: opciones.idioma ?? 'es',
        prompt: { prompt: opciones.prompt ?? 'Sos el agente.', tool_ids: opciones.tools ?? ['t1', 't2'] },
      },
    },
  };
}

const CATALOGO = {
  tools: [
    { id: 't1', tool_config: { name: 'registrar_reporte' } },
    { id: 't2', tool_config: { name: 'escalar_a_humano' } },
    { id: 't3', tool_config: { name: 'avisar_autoridad' } },
  ],
};

describe('AgenteActivoService · quién atiende', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ok = (cuerpo: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(cuerpo) });

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
    fetchMock.mockResolvedValueOnce(
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
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'sin permiso' });

    const { servicio, guardado } = armar();
    const r = await servicio.poner('ag-nuevo');

    expect(guardado[CLAVE_ACTIVO]).toBe('ag-nuevo');
    expect(r.aviso).toMatch(/llamadas entrantes/i);
  });

  describe('revisar antes de cambiar', () => {
    it('un agente completo no levanta reparos', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente())).mockResolvedValueOnce(ok(CATALOGO));

      const { servicio } = armar();
      await expect(servicio.revisar('ag-1')).resolves.toEqual([]);
    });

    it('avisa que está en otro idioma', async () => {
      // Pasó de verdad: un agente en inglés contestándole a un vecino de
      // Tegucigalpa. No falla nada, simplemente habla en el idioma equivocado.
      fetchMock.mockResolvedValueOnce(ok(agente({ idioma: 'en' }))).mockResolvedValueOnce(ok(CATALOGO));

      const r = await armar().servicio.revisar('ag-1');
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ gravedad: 'aviso' });
      expect(r[0].texto).toContain('en');
    });

    it('avisa que no puede abrir un reporte ni pasar el caso', async () => {
      // El peor modo de fallar de este sistema: conversa bien, suena bien en
      // la transcripción y no abre un solo ticket.
      fetchMock.mockResolvedValueOnce(ok(agente({ tools: [] }))).mockResolvedValueOnce(ok(CATALOGO));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /registrar_reporte/.test(x.texto))).toBe(true);
    });

    it('avisa que con «solo texto» las llamadas no levantan', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente({ texto: true }))).mockResolvedValueOnce(ok(CATALOGO));

      const r = await armar().servicio.revisar('ag-1');
      expect(r.some((x) => /llamadas/.test(x.texto))).toBe(true);
    });

    it('un agente sin instrucciones se BLOQUEA, no se avisa', async () => {
      fetchMock.mockResolvedValueOnce(ok(agente({ prompt: '  ' }))).mockResolvedValueOnce(ok(CATALOGO));

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
