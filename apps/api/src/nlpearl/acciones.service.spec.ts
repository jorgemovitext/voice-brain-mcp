import { AccionesService } from './acciones.service';
import { NlpearlActivityStore, StoredActivity } from './activity.store';

/**
 * Las acciones son lo que el operador ve como "te toca a vos" cuando toma el
 * hilo. Se derivan de los mismos avances que empuja el flujo del agente, así
 * que lo que se prueba acá es que sugieran justo lo que el flujo habría hecho
 * solo — ni antes (con datos incompletos) ni de más (si el ticket ya existe).
 */
describe('AccionesService', () => {
  const avance = (paso: string, datos: Record<string, string>): StoredActivity => ({
    id: `avance:c1:${paso}`,
    phone: '+50497616546',
    kind: 'progress',
    occurredAt: '2026-08-24T10:00:00.000Z',
    raw: { conversationId: 'c1', paso, datos },
  });

  const servicio = (avances: StoredActivity[]) =>
    new AccionesService({
      listActivity: async () => avances,
    } as unknown as NlpearlActivityStore);

  const COMPLETO = {
    tipoProblema: 'Fuga de agua',
    ubicacion: 'Colonia Palmira',
    descripcion: 'Sale agua a presión',
  };

  it('sin avances no sugiere nada: no hay conversación que atender', async () => {
    expect(await servicio([]).de('+50497616546', { hay: false })).toEqual([]);
  });

  it('pide registrar en HubSpot cuando ya están los tres datos y no hay ticket', async () => {
    const acciones = await servicio([avance('collectDesc', COMPLETO)]).de('+50497616546', {
      hay: false,
    });

    const crear = acciones.find((a) => a.id === 'crear-ticket');
    expect(crear).toBeDefined();
    expect(crear!.urgente).toBe(true);
    expect(crear!.tipo).toBe('ejecutable');
  });

  it('NO pide registrar si el ticket ya existe', async () => {
    const acciones = await servicio([avance('collectDesc', COMPLETO)]).de('+50497616546', {
      hay: true,
    });

    expect(acciones.find((a) => a.id === 'crear-ticket')).toBeUndefined();
  });

  it('con datos incompletos pide el dato que falta, no el ticket', async () => {
    const acciones = await servicio([
      avance('collectProblem', { tipoProblema: 'Fuga de agua' }),
    ]).de('+50497616546', { hay: false });

    expect(acciones.find((a) => a.id === 'crear-ticket')).toBeUndefined();
    const falta = acciones.find((a) => a.id === 'faltan-datos');
    expect(falta).toBeDefined();
    // El primero que falta en el orden del flujo es la ubicación.
    expect(falta!.etiqueta).toContain('ubicación');
  });

  // La emergencia dejó de ser una etiqueta: la app manda el aviso a la
  // cuadrilla, así que el operador no tiene que ir a buscar el número.
  it('la emergencia es urgente y se puede ejecutar desde la consola', async () => {
    const acciones = await servicio([avance('emergency', COMPLETO)]).de('+50497616546', {
      hay: true,
    });

    const emergencia = acciones.find((a) => a.id === 'emergencia');
    expect(emergencia).toBeDefined();
    expect(emergencia!.urgente).toBe(true);
    expect(emergencia!.tipo).toBe('ejecutable');
  });

  it('sin teléfono no consulta nada', async () => {
    expect(await servicio([avance('collectDesc', COMPLETO)]).de(undefined, { hay: false })).toEqual([]);
  });
});
