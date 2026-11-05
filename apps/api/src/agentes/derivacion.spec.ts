import { SettingsService } from '../shared/settings.service';
import { ConfigDerivacion, DerivacionService, UMBRAL_MINIMO } from './derivacion.service';

/*
 * El cambio de agente decide a quién se le pasa una conversación en curso.
 * Equivocarse acá no se ve como un error: se ve como un vecino al que le
 * contestó el agente equivocado, o al que le cambiaron de agente sin razón
 * en medio de un reporte.
 */

function armar(config?: Partial<ConfigDerivacion>) {
  const guardado: Record<string, unknown> = {};
  if (config) guardado['derivacion:org-1'] = config;

  const settings = {
    get: async (k: string) => guardado[k],
    set: async (k: string, v: unknown) => {
      guardado[k] = v;
      return v;
    },
  } as unknown as SettingsService;

  return { servicio: new DerivacionService(settings), guardado };
}

const REGLA_BACHES = {
  id: 'r1',
  tema: 'Baches, obras y postes',
  agente: 'ag-obras',
  activa: true,
  cambios: 0,
};

describe('DerivacionService · a quién le toca', () => {
  it('reconoce el tema de otro agente y propone cambiar', async () => {
    const { servicio } = armar({ modo: 'automatico', umbral: 90, reglas: [REGLA_BACHES] } as never);

    const d = await servicio.decidir(
      'Hay un bache grande y un poste caído, son obras de la calle',
      'ag-aseo',
      'org-1',
    );

    expect(d).toMatchObject({ agente: 'ag-obras', accion: 'cambiar' });
    expect(d!.confianza).toBe(100);
  });

  it('entre el piso y el umbral PREGUNTA en vez de cambiar', async () => {
    /*
     * Tres de cuatro palabras (75 %) pasa el piso pero no llega al 90 % que
     * pidió el cliente. Ahí la respuesta correcta no es cambiar ni callarse:
     * es preguntar, que es para lo que existe la franja entre los dos.
     */
    const { servicio } = armar({
      modo: 'automatico',
      umbral: 90,
      reglas: [{ ...REGLA_BACHES, tema: 'Baches obras postes semaforos' }],
    } as never);

    const d = await servicio.decidir('hay un bache, obras y un poste caído', 'ag-aseo', 'org-1');

    expect(d?.confianza).toBe(75);
    expect(d?.accion).toBe('preguntar');
  });

  it('por debajo del piso no hace NADA, ni preguntar', async () => {
    // Con menos certeza que el piso, «cambiar» es adivinar — y preguntar
    // «¿querés que te pase con otro?» por una palabra suelta también molesta.
    const { servicio } = armar({
      modo: 'automatico',
      umbral: UMBRAL_MINIMO,
      reglas: [{ ...REGLA_BACHES, tema: 'Baches obras postes alumbrado semaforos' }],
    } as never);

    await expect(servicio.decidir('vi un bache', 'ag-aseo', 'org-1')).resolves.toBeNull();
  });

  it('en modo «preguntar» nunca cambia solo, por alto que sea el número', async () => {
    // El cliente pidió que la persona confirme: un porcentaje no revoca eso.
    const { servicio } = armar({ modo: 'preguntar', umbral: 90, reglas: [REGLA_BACHES] } as never);

    const d = await servicio.decidir('bache, obras y postes', 'ag-aseo', 'org-1');

    expect(d?.confianza).toBe(100);
    expect(d?.accion).toBe('preguntar');
  });

  it('en modo «nunca» no devuelve nada', async () => {
    const { servicio } = armar({ modo: 'nunca', umbral: 90, reglas: [REGLA_BACHES] } as never);
    await expect(servicio.decidir('bache obras postes', 'ag-aseo', 'org-1')).resolves.toBeNull();
  });

  it('no deriva al agente que YA está atendiendo', async () => {
    // Pasarle el caso a quien ya lo tiene sería un cambio vacío anunciado
    // al ciudadano: ruido puro.
    const { servicio } = armar({ modo: 'automatico', umbral: 90, reglas: [REGLA_BACHES] } as never);
    await expect(servicio.decidir('bache obras postes', 'ag-obras', 'org-1')).resolves.toBeNull();
  });

  it('una regla apagada no deriva', async () => {
    const { servicio } = armar({
      modo: 'automatico',
      umbral: 90,
      reglas: [{ ...REGLA_BACHES, activa: false }],
    } as never);
    await expect(servicio.decidir('bache obras postes', 'ag-aseo', 'org-1')).resolves.toBeNull();
  });

  it('las tildes no cambian el resultado', async () => {
    // «bachés» y «baches» son la misma palabra para quien escribe apurado.
    const { servicio } = armar({ modo: 'automatico', umbral: 90, reglas: [REGLA_BACHES] } as never);
    const d = await servicio.decidir('hay BACHÉS, OBRAS y POSTES', 'ag-aseo', 'org-1');
    expect(d?.accion).toBe('cambiar');
  });

  it('las palabras cortas y de unión no emparejan', async () => {
    /*
     * Con «y» o «de» contando, cualquier mensaje emparejaría con cualquier
     * regla y el agente cambiaría todo el tiempo.
     */
    const { servicio } = armar({
      modo: 'automatico',
      umbral: 90,
      reglas: [{ ...REGLA_BACHES, tema: 'Fugas y falta de agua' }],
    } as never);

    // «y», «de» no cuentan; quedan fugas/falta/agua. Esto no trae ninguna.
    await expect(servicio.decidir('hola buenos dias', 'ag-aseo', 'org-1')).resolves.toBeNull();
  });

  it('el piso se respeta aunque lo guardado diga menos', async () => {
    // Una configuración escrita antes de que existiera el piso no puede
    // saltárselo al leerla.
    const { servicio } = armar({ modo: 'automatico', umbral: 10, reglas: [] } as never);
    await expect(servicio.leer('org-1')).resolves.toMatchObject({ umbral: UMBRAL_MINIMO });
  });

  it('guardar no deja que el cliente escriba los contadores', async () => {
    /*
     * «48 cambios este mes» lo lleva el motor. Si viniera del cuerpo de la
     * petición, el panel diría lo que el navegador quiera.
     */
    const { servicio } = armar({ modo: 'automatico', umbral: 90, reglas: [{ ...REGLA_BACHES, cambios: 7 }] } as never);

    const guardada = await servicio.guardar(
      { reglas: [{ ...REGLA_BACHES, cambios: 9999 }] },
      'org-1',
    );

    expect(guardada.reglas[0].cambios).toBe(7);
  });

  it('el mensaje al ciudadano se arma con sus variables', async () => {
    const texto = DerivacionService.redactar(
      'Eso lo atiende {agente}, {ciudadano}. Es tema de {tema}.',
      { agente: 'Obras 100', tema: 'Baches', ciudadano: 'Marlon' },
    );
    expect(texto).toBe('Eso lo atiende Obras 100, Marlon. Es tema de baches.');
  });

  it('cada empresa tiene sus propias reglas', async () => {
    // Las reglas de una clínica no pueden derivar en el taller de al lado.
    const { servicio, guardado } = armar();
    await servicio.guardar({ modo: 'nunca' }, 'org-1');

    expect(guardado['derivacion:org-1']).toBeDefined();
    await expect(servicio.leer('org-2')).resolves.toMatchObject({ modo: 'automatico' });
  });
});
