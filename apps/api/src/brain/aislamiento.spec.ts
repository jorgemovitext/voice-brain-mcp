import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { conContexto } from '../shared/contexto-org';
import { ensureSchema } from '../shared/database.module';
import { PgBrainRepository } from './brain.repository.pg';

/*
 * El aislamiento entre empresas, contra una base de verdad.
 *
 * Es LA propiedad que hace seguro el alta pública: cualquiera se registra,
 * y lo que ve es solo lo suyo. Si esto se rompe, registrarse vuelve a ser
 * leer los teléfonos y las conversaciones de los ciudadanos de otro cliente
 * — el agujero que ya estuvo abierto en producción una vez.
 *
 * Se prueba contra Postgres embebido y no con dobles: lo que puede fallar
 * acá es el SQL —un WHERE que falta, un INSERT que no estampa la columna—
 * y un doble en memoria no tiene SQL que equivocarse.
 */

/**
 * Un `Pool` de mentira sobre PGlite.
 *
 * `query` de PGlite es una sentencia preparada y no admite varias juntas;
 * el esquema viene como un bloque. Por eso lo sin-parámetros va por `exec`,
 * que sí las acepta, y lo parametrizado —las consultas reales— por `query`,
 * que es el camino que se quiere probar.
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

const CLINICA = 'org-clinica';
const TALLER = 'org-taller';

describe('Aislamiento entre organizaciones', () => {
  let repo: PgBrainRepository;
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    const pool = poolDe(db);
    await ensureSchema(pool);
    repo = new PgBrainRepository(pool);
  });

  /** Siembra un contacto con una conversación dentro de una organización. */
  async function sembrar(org: string, nombre: string, telefono: string): Promise<string> {
    return conContexto({ org }, async () => {
      const contacto = await repo.saveContact({
        id: `c-${nombre}`,
        displayName: nombre,
        phones: [telefono],
        externalIds: {},
      });
      await repo.appendInteraction({
        id: `i-${nombre}`,
        contactId: contacto.id,
        channel: 'whatsapp',
        direction: 'inbound',
        occurredAt: new Date().toISOString(),
        summary: `Mensaje de ${nombre}`,
      });
      return contacto.id;
    });
  }

  it('cada empresa ve SOLO sus contactos', async () => {
    await sembrar(CLINICA, 'Paciente', '+50411111111');
    await sembrar(TALLER, 'Cliente', '+50422222222');

    const deClinica = await conContexto({ org: CLINICA }, () => repo.listContacts());
    const deTaller = await conContexto({ org: TALLER }, () => repo.listContacts());

    expect(deClinica.map((c) => c.displayName)).toEqual(['Paciente']);
    expect(deTaller.map((c) => c.displayName)).toEqual(['Cliente']);
  });

  it('cada empresa ve SOLO sus conversaciones', async () => {
    await sembrar(CLINICA, 'Paciente', '+50411111111');
    await sembrar(TALLER, 'Cliente', '+50422222222');

    const deClinica = await conContexto({ org: CLINICA }, () => repo.listInteractions());
    expect(deClinica).toHaveLength(1);
    expect(deClinica[0].summary).toBe('Mensaje de Paciente');
  });

  it('no se puede leer un contacto ajeno ni sabiendo su id', async () => {
    // El id es adivinable y viaja en la URL: el filtro no puede depender de
    // que nadie lo pruebe.
    const ajeno = await sembrar(TALLER, 'Cliente', '+50422222222');

    const robado = await conContexto({ org: CLINICA }, () => repo.getContact(ajeno));
    expect(robado).toBeUndefined();
  });

  it('no se puede encontrar a alguien de otra empresa por su teléfono', async () => {
    /*
     * Buscar por teléfono es el camino del webhook y el de la barra de
     * búsqueda. Sin el filtro, escribir un número en la consola de una
     * empresa devolvía la ficha del ciudadano de otra.
     */
    await sembrar(TALLER, 'Cliente', '+50422222222');

    const hallado = await conContexto({ org: CLINICA }, () => repo.findContactByPhone('+50422222222'));
    expect(hallado).toBeUndefined();
  });

  it('dos empresas pueden tener al MISMO teléfono sin pisarse', async () => {
    // Una persona puede ser paciente de una clínica y cliente de un taller.
    // Si el teléfono fuera único global, la segunda empresa no podría darla
    // de alta — y el aislamiento se notaría como un bug de negocio.
    await sembrar(CLINICA, 'Paciente', '+50499999999');
    await sembrar(TALLER, 'Cliente', '+50499999999');

    const enClinica = await conContexto({ org: CLINICA }, () => repo.findContactByPhone('+50499999999'));
    const enTaller = await conContexto({ org: TALLER }, () => repo.findContactByPhone('+50499999999'));

    expect(enClinica?.displayName).toBe('Paciente');
    expect(enTaller?.displayName).toBe('Cliente');
  });

  it('sin contexto de organización NO se ve nada', async () => {
    /*
     * El peor caso posible tiene que ser «no se ve nada», nunca «se ve lo de
     * todos». Un camino que corra fuera de una petición —un cron, un script,
     * el servidor MCP— no hereda organización, y eso debe devolver vacío en
     * vez de la base entera.
     */
    await sembrar(CLINICA, 'Paciente', '+50411111111');
    await sembrar(TALLER, 'Cliente', '+50422222222');

    expect(await repo.listContacts()).toEqual([]);
    expect(await repo.listInteractions()).toEqual([]);
  });

  it('la historia anterior queda con dueño, no huérfana', async () => {
    /*
     * Lo que se guardó antes de que existieran las organizaciones no puede
     * quedar en NULL: se escondería de todos y parecería que se perdió.
     * La migración le pone dueño explícito.
     */
    await db.exec(`
      INSERT INTO contacts (id, display_name, phones, external_ids)
      VALUES ('viejo', 'Vecino de la Línea 100', '["+50497616546"]', '{}');
      UPDATE contacts SET organizacion_id = NULL WHERE id = 'viejo';
    `);
    await ensureSchema(poolDe(db));

    const r = await db.query<{ organizacion_id: string }>(
      `SELECT organizacion_id FROM contacts WHERE id = 'viejo'`,
    );
    expect(r.rows[0].organizacion_id).toBe('org-movitext');
  });
});
