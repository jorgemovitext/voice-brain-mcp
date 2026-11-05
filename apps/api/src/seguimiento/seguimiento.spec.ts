import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { ensureSchema } from '../shared/database.module';
import { SettingsService } from '../shared/settings.service';
import { cuandoToca, proximaVentana, SeguimientoService } from './seguimiento.service';
import { redactar, secuencia } from './secuencias';

/*
 * El seguimiento es lo único de Hive que puede molestar de verdad. Un agente
 * que contesta mal es un agente malo; un agente que escribe tres veces sin
 * que nadie le pregunte es acoso, y lo bloquean — y un número bloqueado por
 * muchos es una cuenta de WhatsApp de la que no se vuelve.
 *
 * Por eso lo que se prueba acá no es «manda el mensaje»: son los cuatro
 * frenos que hacen que el módulo se pueda encender sin miedo.
 */

function poolDe(db: PGlite): Pool {
  return {
    query: async (texto: string, params?: unknown[]) => {
      if (!params?.length) {
        const r = await db.exec(texto);
        return { rows: r[r.length - 1]?.rows ?? [], rowCount: r[r.length - 1]?.rows?.length ?? 0 };
      }
      return db.query(texto, params as never);
    },
  } as unknown as Pool;
}

const ORG = 'org-clinica';

describe('Cuándo le toca cada paso', () => {
  it('cuenta hacia atrás para avisar ANTES de la cita', () => {
    const cita = new Date('2026-12-01T15:00:00Z');
    const paso = secuencia('recordatorio-cita')!.pasos[0];

    expect(paso.horas).toBeLessThan(0);
    // 24 h antes, no 24 h después: contar mal acá manda el recordatorio al
    // día siguiente de la cita.
    expect(cuandoToca(cita, paso, new Date('2026-11-01T00:00:00Z')).toISOString()).toBe(
      '2026-11-30T15:00:00.000Z',
    );
  });

  it('un aviso que ya quedó en el pasado se manda enseguida, no se pierde', () => {
    /*
     * Se agenda una cita para dentro de una hora y el primer aviso era de
     * 24 h antes. Si se guardara con fecha pasada quedaría vencido para
     * siempre y la persona no recibiría nada — el fallo que nadie reporta.
     */
    const ahora = new Date('2026-12-01T14:00:00Z');
    const cita = new Date('2026-12-01T15:00:00Z');
    const paso = secuencia('recordatorio-cita')!.pasos[0];

    expect(cuandoToca(cita, paso, ahora).getTime()).toBe(ahora.getTime());
  });
});

describe('No molestar de noche', () => {
  it('a media mañana se puede escribir', () => {
    // 15:00 UTC = 09:00 en Honduras.
    expect(proximaVentana(new Date('2026-11-05T15:00:00Z'))).toBeNull();
  });

  it('a las 2 de la mañana se POSPONE, no se cancela', () => {
    /*
     * Cancelar perdería el recordatorio de la cita por haber caído a las
     * 23:40. Se corre a la mañana y sale igual.
     */
    const madrugada = new Date('2026-11-05T08:00:00Z'); // 02:00 en Honduras
    const cuando = proximaVentana(madrugada);

    expect(cuando).not.toBeNull();
    expect(cuando!.getTime()).toBeGreaterThan(madrugada.getTime());
    // Las 07:05 locales = 13:05 UTC, del mismo día.
    expect(cuando!.toISOString()).toBe('2026-11-05T13:05:00.000Z');
  });

  it('a las 10 de la noche espera a la mañana SIGUIENTE', () => {
    const noche = new Date('2026-11-05T04:00:00Z'); // 22:00 del 4 en Honduras
    const cuando = proximaVentana(noche);
    expect(cuando!.toISOString()).toBe('2026-11-05T13:05:00.000Z');
  });
});

describe('El texto que recibe la persona', () => {
  it('sin nombre no deja el hueco a la vista', () => {
    // «Hola {nombre},» en un WhatsApp real es lo que delata que atrás no
    // hay nadie.
    const texto = redactar('Hola {nombre}, tu cita en {negocio} es mañana.', { negocio: 'Clínica San Jorge' });
    expect(texto).toBe('Hola, tu cita en Clínica San Jorge es mañana.');
  });

  it('con nombre, saluda por su nombre', () => {
    const texto = redactar('Hola {nombre}, tu cita en {negocio} es mañana.', {
      nombre: 'Marlon',
      negocio: 'Clínica San Jorge',
    });
    expect(texto).toBe('Hola Marlon, tu cita en Clínica San Jorge es mañana.');
  });
});

describe('La corrida del seguimiento', () => {
  let db: PGlite;
  let pool: Pool;

  /** El servicio con todo lo de afuera controlado. */
  function armar(opciones: {
    plan?: string;
    activas?: Record<string, boolean>;
    /** Interacciones del hilo: con una entrante nueva, contestó. */
    entranteNueva?: boolean;
    /** Cuántos mensajes no pedidos ya recibió esta semana. */
    iniciados?: number;
    puedeEnviar?: boolean;
  }) {
    const enviados: Array<{ contacto: string; texto: string; motivo?: string }> = [];
    const config = { activas: opciones.activas ?? { 'avance-reporte': true } };
    const datos: Record<string, unknown> = {};

    const settings = {
      // Misma configuración para cualquier empresa: lo que se prueba acá no
      // es de quién es la clave, y un doble que solo contesta por una deja
      // sin inscribir a la segunda sin decir por qué.
      get: async (k: string) => (k.startsWith('seguimiento:') ? config : datos[k]),
      set: async (k: string, v: unknown) => {
        datos[k] = v;
        return v;
      },
    } as unknown as SettingsService;

    const brain = {
      getContext: async () => ({
        contact: { id: 'c1', displayName: 'Marlon', phones: ['+50433030235'], externalIds: {} },
        recentInteractions: opciones.entranteNueva
          ? [{ direction: 'inbound', occurredAt: new Date(Date.now() + 1000).toISOString() }]
          : [],
        signals: [],
      }),
      appendInteraction: async () => undefined,
    };

    const medicion = { iniciadosRecientes: async () => opciones.iniciados ?? 0, tarifaOrg: async () => undefined };
    const limites = {
      habilita: async () => (opciones.plan ?? 'negocio') !== 'prueba',
      puedeEnviar: async () =>
        opciones.puedeEnviar === false ? { ok: false, motivo: 'sin presupuesto' } : { ok: true },
      planDe: async () => ({ id: opciones.plan ?? 'negocio' }),
    };
    const organizaciones = { leer: async () => ({ nombre: 'Clínica San Jorge' }) };
    const canal = {
      channel: 'whatsapp',
      send: async (contacto: string, texto: string, intencion?: { motivo?: string }) => {
        enviados.push({ contacto, texto, motivo: intencion?.motivo });
        return { delivered: true, providerId: `wa-${enviados.length}` };
      },
    };

    const servicio = new SeguimientoService(
      pool,
      brain as never,
      medicion as never,
      limites as never,
      settings,
      organizaciones as never,
      canal as never,
    );
    return { servicio, enviados };
  }

  /** Adelanta el reloj de la cola: deja todo vencido. */
  async function vencer() {
    await db.exec(`UPDATE seguimientos SET toca = now() - interval '1 hour'`);
  }

  /** Mueve la hora de creación hacia atrás, como si el paso fuera de ayer. */
  async function creadoHace(horas: number) {
    await db.exec(`UPDATE seguimientos SET creado = now() - interval '${horas} hours'`);
  }

  beforeAll(async () => {
    db = new PGlite();
    pool = poolDe(db);
    await ensureSchema(pool);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec('TRUNCATE seguimientos');
  });

  it('manda el primer paso y queda esperando el segundo', async () => {
    const { servicio, enviados } = armar({});

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG, agente: 'ag-obras' });
    await vencer();
    const resumen = await servicio.correr();

    expect(resumen.enviados).toBe(1);
    expect(enviados[0].texto).toContain('Clínica San Jorge');
    // Se cobra como seguimiento, no como respuesta: cuesta distinto.
    expect(enviados[0].motivo).toBe('seguimiento');

    const fila = await db.query<{ paso: number; estado: string }>('SELECT paso, estado FROM seguimientos');
    expect(fila.rows[0]).toMatchObject({ paso: 1, estado: 'pendiente' });
  });

  it('si la persona contestó, se corta y NO se le escribe', async () => {
    // El freno más importante: seguir la secuencia después de que alguien
    // respondió es escribirle encima de su propia conversación.
    const { servicio, enviados } = armar({ entranteNueva: true });

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    await vencer();
    const resumen = await servicio.correr();

    expect(enviados).toHaveLength(0);
    expect(resumen.cortados).toBe(1);
    const fila = await db.query<{ estado: string; motivo_fin: string }>(
      'SELECT estado, motivo_fin FROM seguimientos',
    );
    expect(fila.rows[0]).toMatchObject({ estado: 'cortado', motivo_fin: 'la persona contestó' });
  });

  it('inscribir dos veces deja UNA inscripción', async () => {
    /*
     * Dos mensajes seguidos de la misma persona inscriben dos veces. Sin el
     * índice único, recibiría toda la secuencia duplicada — y se le cobraría
     * al cliente dos veces por cada paso.
     */
    const { servicio } = armar({});

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    const segunda = await servicio.inscribir('c1', 'avance-reporte', { org: ORG });

    expect(segunda).toBeNull();
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM seguimientos');
    expect(r.rows[0].n).toBe(1);
  });

  it('a quien ya recibió su cupo de la semana no se le escribe más', async () => {
    const { servicio, enviados } = armar({ iniciados: 3 });

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    await vencer();
    const resumen = await servicio.correr();

    expect(enviados).toHaveLength(0);
    expect(resumen.cortados).toBe(1);
  });

  it('sin presupuesto se corta: una secuencia no puede vaciarle la cuenta al cliente', async () => {
    const { servicio, enviados } = armar({ puedeEnviar: false });

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    await vencer();
    await servicio.correr();

    expect(enviados).toHaveLength(0);
  });

  it('el plan de prueba no inscribe a nadie', async () => {
    const { servicio } = armar({ plan: 'prueba' });

    await expect(servicio.inscribir('c1', 'avance-reporte', { org: ORG })).resolves.toBeNull();
  });

  it('una secuencia apagada no inscribe', async () => {
    const { servicio } = armar({ activas: { 'avance-reporte': false } });

    await expect(servicio.inscribir('c1', 'avance-reporte', { org: ORG })).resolves.toBeNull();
  });

  it('al terminar los pasos, la secuencia queda hecha y no vuelve a sonar', async () => {
    const { servicio, enviados } = armar({ activas: { 'como-fue': true } });

    // «Cómo fue» tiene UN solo paso: al mandarlo, terminó.
    await servicio.inscribir('c1', 'como-fue', { org: ORG });
    await vencer();
    await servicio.correr();
    await servicio.correr();

    expect(enviados).toHaveLength(1);
    const fila = await db.query<{ estado: string }>('SELECT estado FROM seguimientos');
    expect(fila.rows[0].estado).toBe('hecho');
  });

  it('el segundo paso se cuenta desde la inscripción, no desde el primer envío', async () => {
    /*
     * Si se contara desde el envío, un paso postergado por la noche
     * arrastraría a todos los siguientes: el «a la semana» saldría a los
     * ocho días, y con tres pasos la secuencia se correría sola.
     */
    const { servicio } = armar({});

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    await creadoHace(30);
    await vencer();
    await servicio.correr();

    const sec = secuencia('avance-reporte')!;
    const fila = await db.query<{ toca: string; creado: string }>('SELECT toca, creado FROM seguimientos');
    const esperado = new Date(fila.rows[0].creado).getTime() + sec.pasos[1].horas * 3600_000;
    // Al segundo: lo que se comprueba es el ORIGEN de la cuenta, no la
    // precisión del reloj de la base.
    expect(Math.abs(new Date(fila.rows[0].toca).getTime() - esperado)).toBeLessThan(1_000);
  });

  it('cortar al contestar no toca los seguimientos de otra empresa', async () => {
    const { servicio } = armar({});

    await servicio.inscribir('c1', 'avance-reporte', { org: ORG });
    await servicio.inscribir('c1', 'avance-reporte', { org: 'org-taller' });

    await servicio.cortar('c1', 'contestó', ORG);

    const r = await db.query<{ organizacion_id: string; estado: string }>(
      'SELECT organizacion_id, estado FROM seguimientos ORDER BY organizacion_id',
    );
    expect(r.rows.find((f) => f.organizacion_id === ORG)!.estado).toBe('cortado');
    expect(r.rows.find((f) => f.organizacion_id === 'org-taller')!.estado).toBe('pendiente');
  });
});
