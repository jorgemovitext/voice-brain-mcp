import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { conContexto } from '../shared/contexto-org';
import { ensureSchema } from '../shared/database.module';
import { SettingsService } from '../shared/settings.service';
import { LimitesService } from './limites.service';
import { MedicionService } from './medicion.service';
import { OrganizacionesService } from '../auth/organizaciones.service';

/*
 * El cobro de los mensajes, contra una base de verdad.
 *
 * Se prueba con Postgres embebido y no con dobles porque lo que puede
 * fallar acá es el SQL: una suma que agrupa mal, un índice único que no
 * frena el reintento del proveedor, un precio que se recalcula al leer. Un
 * doble en memoria no tiene SQL que equivocarse.
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

/** Settings en memoria: lo que importa acá es la base, no dónde van las claves. */
function settingsDe(inicial: Record<string, unknown> = {}): SettingsService {
  const datos = { ...inicial };
  return {
    get: async (k: string) => datos[k],
    set: async (k: string, v: unknown) => {
      datos[k] = v;
      return v;
    },
  } as unknown as SettingsService;
}

const CLINICA = 'org-clinica';

describe('Medición de mensajes', () => {
  let db: PGlite;
  let pool: Pool;
  let medicion: MedicionService;

  beforeAll(async () => {
    db = new PGlite();
    pool = poolDe(db);
    await ensureSchema(pool);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec('TRUNCATE consumo');
    medicion = new MedicionService(pool, settingsDe());
  });

  it('anota el mensaje con el país que le toca', async () => {
    await medicion.registrar({ organizacion: CLINICA, destino: '+50433030235', categoria: 'servicio' });

    const uso = await medicion.detalle(CLINICA);
    expect(uso.mensajes).toBe(1);
    expect(uso.porPais[0]).toMatchObject({ pais: 'HN', categoria: 'servicio' });
    expect(uso.micros).toBeGreaterThan(0);
  });

  it('el precio queda CONGELADO: cambiar la tarifa no reescribe lo ya cobrado', async () => {
    /*
     * Es la propiedad más importante del módulo. Si la factura se armara
     * con la tarifa vigente, subir un precio hoy cambiaría el total del mes
     * pasado — y el cliente que compara dos facturas tendría razón en
     * reclamar.
     */
    await medicion.registrar({ organizacion: CLINICA, destino: '+50433030235' });
    const antes = (await medicion.consumo(CLINICA)).micros;

    // Se negocia (o se corrige) la tarifa DESPUÉS del envío.
    const conTarifaNueva = new MedicionService(
      pool,
      settingsDe({ [`tarifas:${CLINICA}`]: { paises: { HN: { servicio: 999_000 } } } }),
    );

    expect((await conTarifaNueva.consumo(CLINICA)).micros).toBe(antes);

    // Y el próximo mensaje sí sale con el precio nuevo.
    await conTarifaNueva.registrar({ organizacion: CLINICA, destino: '+50433030235' });
    expect((await conTarifaNueva.consumo(CLINICA)).micros).toBe(antes + 999_000);
  });

  it('un webhook reintentado no cobra dos veces', async () => {
    // Los proveedores reintentan. Sin el índice único por referencia, cada
    // reintento es un mensaje más en la factura por un mensaje que salió una vez.
    await medicion.registrar({ organizacion: CLINICA, destino: '+50433030235', referencia: 'wa-1' });
    await medicion.registrar({ organizacion: CLINICA, destino: '+50433030235', referencia: 'wa-1' });

    expect((await medicion.consumo(CLINICA)).mensajes).toBe(1);
  });

  it('cada empresa ve solo su consumo', async () => {
    await medicion.registrar({ organizacion: CLINICA, destino: '+50433030235' });
    await medicion.registrar({ organizacion: 'org-taller', destino: '+50499999999' });

    expect((await medicion.consumo(CLINICA)).mensajes).toBe(1);
    expect((await medicion.consumo('org-taller')).mensajes).toBe(1);
  });

  it('toma la organización del contexto cuando no se la pasan', async () => {
    // Es el camino del webhook: el envío no sabe de quién es, el contexto sí.
    await conContexto({ org: CLINICA }, () => medicion.registrar({ destino: '+50433030235' }));
    expect((await medicion.consumo(CLINICA)).mensajes).toBe(1);
  });

  it('un mensaje sin dueño queda anotado, no desaparece', async () => {
    /*
     * Un envío sin organización es plata que no se factura. Descartarlo
     * dejaría la plata perdida Y sin rastro de dónde salió; así al menos
     * aparece en el arqueo.
     */
    await medicion.registrar({ destino: '+50433030235' });
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM consumo WHERE organizacion_id = 'sin-organizacion'`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('cuenta los mensajes que iniciamos nosotros, no los que contestamos', async () => {
    // Es el freno contra el acoso: lo que cuenta es lo no pedido.
    await medicion.registrar({ organizacion: CLINICA, contacto: 'c1', destino: '+504111', motivo: 'respuesta' });
    await medicion.registrar({ organizacion: CLINICA, contacto: 'c1', destino: '+504111', motivo: 'seguimiento' });
    await medicion.registrar({ organizacion: CLINICA, contacto: 'c1', destino: '+504111', motivo: 'seguimiento' });

    expect(await medicion.iniciadosRecientes(CLINICA, 'c1')).toBe(2);
  });
});

describe('Topes y planes', () => {
  let db: PGlite;
  let pool: Pool;

  /** Una organización con el plan que se le indique. */
  function orgsCon(plan: string): OrganizacionesService {
    return { leer: async () => ({ id: CLINICA, nombre: 'Clínica', plan, creada: '' }) } as never;
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
    await db.exec('TRUNCATE consumo');
  });

  /** Mete `n` mensajes ya cobrados en el período actual. */
  async function consumir(medicion: MedicionService, n: number, motivo = 'respuesta') {
    for (let i = 0; i < n; i += 1) {
      await medicion.registrar({
        organizacion: CLINICA,
        destino: '+50433030235',
        motivo: motivo as never,
        referencia: `m-${motivo}-${i}`,
      });
    }
  }

  it('en la prueba, agotar la bolsa corta todo', async () => {
    // Quien no dio una forma de pago no puede generar una deuda.
    const settings = settingsDe();
    const medicion = new MedicionService(pool, settings);
    const limites = new LimitesService(medicion, orgsCon('prueba'), settings);

    const estado = await limites.estado(CLINICA);
    await consumir(medicion, estado.incluidos);

    const veredicto = await limites.puedeEnviar(CLINICA, { motivo: 'respuesta' });
    expect(veredicto.ok).toBe(false);
    expect(veredicto.motivo).toMatch(/se acabaron/i);
  });

  it('con el tope alcanzado NO se inician conversaciones, pero SÍ se contesta', async () => {
    /*
     * La asimetría que ordena todo el módulo. Contestarle a alguien que
     * acaba de escribir es el servicio: cortarlo por un tope de gasto es
     * dejar a un vecino sin respuesta por una razón administrativa. Iniciar
     * una conversación es gasto discrecional nuestro, y ahí sí se corta.
     */
    const settings = settingsDe();
    const medicion = new MedicionService(pool, settings);
    const limites = new LimitesService(medicion, orgsCon('negocio'), settings);

    // Un tope diminuto y consumo por encima de lo incluido.
    await limites.fijarTope(CLINICA, 1);
    const estado = await limites.estado(CLINICA);
    await consumir(medicion, estado.incluidos + 5);

    const despues = await limites.estado(CLINICA);
    expect(despues.exceso).toBe(5);
    expect(despues.motivo).toBe('tope-alcanzado');

    await expect(limites.puedeEnviar(CLINICA, { motivo: 'respuesta' })).resolves.toMatchObject({ ok: true });
    await expect(
      limites.puedeEnviar(CLINICA, { motivo: 'seguimiento', categoria: 'utilidad' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('sin tope, el exceso no frena nada', async () => {
    const settings = settingsDe();
    const medicion = new MedicionService(pool, settings);
    const limites = new LimitesService(medicion, orgsCon('negocio'), settings);

    const estado = await limites.estado(CLINICA);
    await consumir(medicion, estado.incluidos + 3);

    await expect(limites.puedeEnviar(CLINICA, { motivo: 'seguimiento' })).resolves.toMatchObject({ ok: true });
  });

  it('un tope negativo no deja la cuenta muda', async () => {
    // Cortar todo se hace pausando la línea, no con un tope en -1 escrito
    // por error en un formulario.
    const settings = settingsDe();
    const limites = new LimitesService(new MedicionService(pool, settings), orgsCon('negocio'), settings);
    const ajustes = await limites.fijarTope(CLINICA, -500);
    expect(ajustes.topeMicros).toBe(0);
  });

  it('si no se puede leer el estado, se deja pasar', async () => {
    /*
     * Una base caída no puede convertirse en un agente mudo: el riesgo de
     * cobrar un mensaje de más es menor que el de no contestarle a alguien.
     */
    const settings = settingsDe();
    const limites = new LimitesService(
      { consumo: async () => { throw new Error('Neon caído'); } } as never,
      orgsCon('negocio'),
      settings,
    );
    await expect(limites.puedeEnviar(CLINICA)).resolves.toMatchObject({ ok: true });
  });

  it('el plan manda sobre las funciones, no la pantalla', async () => {
    const settings = settingsDe();
    const medicion = new MedicionService(pool, settings);

    const prueba = new LimitesService(medicion, orgsCon('prueba'), settings);
    const institucional = new LimitesService(medicion, orgsCon('institucional'), settings);

    await expect(prueba.habilita(CLINICA, 'seguimiento')).resolves.toBe(false);
    await expect(prueba.habilita(CLINICA, 'cambio-agente')).resolves.toBe(false);
    await expect(institucional.habilita(CLINICA, 'cambio-agente')).resolves.toBe(true);
  });
});
