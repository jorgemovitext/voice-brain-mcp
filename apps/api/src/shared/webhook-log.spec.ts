import { Pool } from 'pg';
import { SettingsService } from './settings.service';
import { WebhookEvent, WebhookLogService } from './webhook-log.service';

/*
 * Dos bugs cubren estas pruebas, los dos con el mismo síntoma: Actividad vacía
 * y "Entrantes de Gupshup: NUNCA" aunque el proveedor sí nos hubiera pegado.
 * O sea, el diagnóstico fallando justo cuando hace falta.
 *
 * 1. `push()` agendaba el guardado y nadie lo esperaba. En Vercel la instancia
 *    se congela apenas se devuelve la respuesta, así que la escritura quedaba
 *    a medias y el evento se perdía. Se simula resolviendo la escritura DESPUÉS
 *    de que el controlador ya respondió: si nadie esperó, no llegó al almacén.
 *
 * 2. La bitácora se guardaba en Vercel Blob. Al mudar el almacenamiento a Neon
 *    ese store quedó desconectado y su token vacío, así que pasó a ser solo
 *    memoria — y la memoria muere con la instancia.
 */

/** Postgres simulado, con la escritura bajo control del test. */
function pgFalso() {
  const sentencias: Array<{ sql: string; params: unknown[] }> = [];
  let soltar: (() => void) | null = null;

  return {
    sentencias,
    /** Espera a que haya una escritura en vuelo y la suelta. */
    completar: async () => {
      for (let intento = 0; !soltar && intento < 50; intento++) await Promise.resolve();
      if (!soltar) throw new Error('no había ninguna escritura en vuelo');
      const ahora = soltar;
      soltar = null;
      ahora();
    },
    query: (sql: string, params: unknown[]) =>
      new Promise((resolve) => {
        // La creación del esquema no es una escritura de la bitácora.
        if (sql.includes('CREATE TABLE')) return resolve({ rows: [] });
        soltar = () => {
          sentencias.push({ sql, params });
          resolve({ rows: [] });
        };
      }),
  };
}

function servicio(pg: ReturnType<typeof pgFalso>, guardados: WebhookEvent[] = []) {
  const settings = { get: async () => guardados, set: async () => undefined };
  return new WebhookLogService(pg as unknown as Pool, settings as unknown as SettingsService);
}

describe('WebhookLogService: la bitácora sobrevive al congelamiento', () => {
  it('flush() espera al guardado en curso', async () => {
    const pg = pgFalso();
    const log = servicio(pg);

    log.push('gupshup', 'Evento recibido (gupshup:message)');

    const esperando = log.flush();
    expect(pg.sentencias).toHaveLength(0); // todavía no se guardó nada

    await pg.completar();
    await esperando;

    expect(pg.sentencias).toHaveLength(1);
    expect(JSON.stringify(pg.sentencias[0].params)).toContain('gupshup:message');
  });

  it('encadena los guardados: dos eventos seguidos no se pisan', async () => {
    const pg = pgFalso();
    const log = servicio(pg);

    log.push('gupshup', 'primero');
    log.push('gupshup', 'segundo');

    const esperando = log.flush();
    // Encadenados, no en paralelo: el segundo no arranca hasta soltar el primero.
    await pg.completar();
    await pg.completar();
    await esperando;

    expect(pg.sentencias).toHaveLength(2);
    expect(JSON.stringify(pg.sentencias[0].params)).toContain('primero');
    expect(JSON.stringify(pg.sentencias[1].params)).toContain('segundo');
  });

  it('cada evento se agrega con UNA sentencia, sin leer la lista antes', async () => {
    /*
     * Es lo que evita perder eventos entre instancias: con leer-modificar-
     * escribir, dos webhooks simultáneos leen la misma lista y el segundo en
     * escribir borra el evento del primero. Acá Postgres concatena y recorta
     * del lado del servidor, así que la sentencia manda UN evento, no la lista.
     */
    const pg = pgFalso();
    const log = servicio(pg, [{ at: '2026-01-01T00:00:00.000Z', source: 'gupshup', summary: 'viejo', ok: true }]);

    log.push('agente', 'nuevo');
    const esperando = log.flush();
    await pg.completar();
    await esperando;

    const { sql, params } = pg.sentencias[0];
    expect(JSON.parse(params[1] as string)).toHaveLength(1);
    expect(sql).toContain('jsonb_array_elements');
    expect(sql).toContain('EXCLUDED.value || app_settings.value');
    // Recorta por posición y no con LIMIT: sin orden explícito, recortar podría
    // tirar el evento nuevo en vez del más viejo.
    expect(sql).toContain('WITH ORDINALITY');
    expect(sql).toContain('ORDER BY ord');
    // Y no manda lo que ya estaba guardado: eso lo concatena la base.
    expect(JSON.stringify(params)).not.toContain('viejo');
  });

  it('si el guardado falla, lo dice EN la bitácora y no solo en los registros', async () => {
    /*
     * Es la lección del store de Blob desconectado: la lista se veía vacía, el
     * warn quedaba en los registros de Vercel y no había nada que dijera por
     * qué — así que parecía que los proveedores no estaban pegando.
     */
    const roto = { query: async () => { throw new Error('relation no existe'); } };
    const log = servicio(roto as unknown as ReturnType<typeof pgFalso>);

    log.push('gupshup', 'Evento recibido');
    await log.flush();

    const lista = await log.list();
    expect(lista[0].ok).toBe(false);
    expect(lista[0].summary).toContain('La bitácora no se está guardando');
    expect(lista[0].summary).toContain('relation no existe');
    // El evento real no se pierde: sigue estando el de esta instancia.
    expect(lista.map((e) => e.summary)).toContain('Evento recibido');
  });

  it('list() muestra lo guardado y lo de esta instancia, sin repetir', async () => {
    const pg = pgFalso();
    const guardado: WebhookEvent = {
      at: '2026-01-01T00:00:00.000Z',
      source: 'gupshup',
      summary: 'de otra instancia',
      ok: true,
    };
    const log = servicio(pg, [guardado]);

    log.push('agente', 'recién registrado');
    const lista = await log.list();

    // El recién registrado se ve aunque su escritura no haya cerrado todavía.
    expect(lista.map((e) => e.summary)).toEqual(['recién registrado', 'de otra instancia']);
  });

  it('sin nada agendado, flush() no bloquea', async () => {
    const pg = pgFalso();
    const log = servicio(pg);
    // Nunca se llama a `completar`: si flush() esperara algo, esto colgaría.
    await log.flush();
    expect(pg.sentencias).toHaveLength(0);
  });
});
