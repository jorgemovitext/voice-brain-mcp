import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AgenteActivoService } from '../shared/agente-activo.service';
import { LineasService } from './lineas.service';

/*
 * Las líneas son la unidad del SaaS: si el routing por destino se equivoca,
 * el agente de un cliente le contesta a los ciudadanos de otro. Eso no se
 * nota en ningún error — se nota en un vecino de la AMDC recibiendo precios
 * de una clínica.
 */

/** Un pool falso: guarda las filas en memoria y entiende las 5 consultas del servicio. */
function poolFalso(filas: Array<Record<string, unknown>> = []) {
  const lineas = [...filas];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT 1 FROM lineas')) return { rows: lineas.slice(0, 1), rowCount: 0 };
    if (sql.startsWith('SELECT * FROM lineas WHERE id')) {
      return { rows: lineas.filter((l) => l['id'] === params[0]), rowCount: 0 };
    }
    if (sql.startsWith('SELECT * FROM lineas')) return { rows: lineas, rowCount: 0 };
    if (sql.includes("estado = 'activa'")) {
      const [destino, digitos] = params as [string, string];
      const halladas = lineas.filter(
        (l) =>
          l['estado'] === 'activa' &&
          (l['destino'] === destino ||
            (digitos !== '' && String(l['numero']).replace(/\D/g, '') === digitos)),
      );
      return { rows: halladas, rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO lineas')) {
      const [id, cliente, nombre, numero, destino, agente, estado, creado] = params as string[];
      if (lineas.some((l) => l['numero'] === numero)) {
        const err = new Error('duplicate key') as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      lineas.push({ id, cliente, nombre, numero, destino, agente, estado, creado: creado ?? new Date().toISOString() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE lineas')) {
      const [id, cliente, nombre, agente, estado, destino] = params as string[];
      const fila = lineas.find((l) => l['id'] === id);
      if (fila) Object.assign(fila, { cliente, nombre, agente, estado, destino });
      return { rows: [], rowCount: fila ? 1 : 0 };
    }
    if (sql.startsWith('DELETE FROM lineas')) {
      const antes = lineas.length;
      const resto = lineas.filter((l) => l['id'] !== params[0]);
      lineas.length = 0;
      lineas.push(...resto);
      return { rows: [], rowCount: antes - lineas.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, lineas, query };
}

function armar(filas: Array<Record<string, unknown>> = [], env: Record<string, string> = {}) {
  const { pool, lineas, query } = poolFalso(filas);
  const puestos: string[] = [];
  const activo = {
    id: async () => 'ag-entorno',
    poner: async (id: string) => {
      puestos.push(id);
      return { numeros: [] };
    },
  } as unknown as AgenteActivoService;
  const config = { get: (k: string, d?: string) => env[k] ?? d ?? '' } as ConfigService;
  return { servicio: new LineasService(pool, activo, config), lineas, puestos, query };
}

const LINEA_100 = {
  id: 'l1',
  cliente: 'AMDC',
  nombre: 'Línea 100',
  numero: '+50433030235',
  destino: 'Linea100App',
  agente: 'ag-linea100',
  estado: 'activa',
  creado: '2026-11-01T00:00:00.000Z',
};

describe('LineasService · el número de cada cliente', () => {
  it('enruta por nombre de app (formato Gupshup)', async () => {
    const { servicio } = armar([LINEA_100]);
    await expect(servicio.agenteDe('Linea100App')).resolves.toMatchObject({ agente: 'ag-linea100' });
  });

  it('enruta por número aunque venga sin el «+» (formato Meta)', async () => {
    const { servicio } = armar([LINEA_100]);
    await expect(servicio.agenteDe('50433030235')).resolves.toMatchObject({ agente: 'ag-linea100' });
  });

  it('una línea pausada NO atiende', async () => {
    // Pausar es el botón de emergencia del operador: si el routing la
    // siguiera eligiendo, pausar no serviría de nada.
    const { servicio } = armar([{ ...LINEA_100, estado: 'pausada' }]);
    await expect(servicio.agenteDe('Linea100App')).resolves.toBeNull();
  });

  it('un destino desconocido devuelve null: decide el que llama', async () => {
    const { servicio } = armar([LINEA_100]);
    await expect(servicio.agenteDe('OtraApp')).resolves.toBeNull();
    await expect(servicio.agenteDe(undefined)).resolves.toBeNull();
  });

  it('crear valida el número y deja el agente LISTO para contestar', async () => {
    const { servicio, puestos } = armar([]);

    await expect(
      servicio.crear({ cliente: 'Clínica', nombre: 'Citas', numero: '12345', agente: 'ag-c' }),
    ).rejects.toThrow(BadRequestException);

    const linea = await servicio.crear({
      cliente: 'Clínica San Jorge',
      nombre: 'Citas',
      numero: '+504 8888-7777',
      agente: 'ag-clinica',
    });

    expect(linea.numero).toBe('+50488887777');
    // La lección de Movi, por línea: sin poner() el agente muere en silencio.
    expect(puestos).toEqual(['ag-clinica']);
  });

  it('un número no puede tener dos líneas', async () => {
    const { servicio } = armar([LINEA_100]);
    await expect(
      servicio.crear({ cliente: 'Otro', nombre: 'Otra', numero: '+50433030235', agente: 'ag-x' }),
    ).rejects.toThrow(/ya tiene una línea/);
  });

  it('siembra la Línea 100 desde la configuración cuando la tabla está vacía', async () => {
    /*
     * El día del deploy la tabla nace vacía pero hay una línea REAL
     * atendiendo. Sin la siembra, Canales aparecería vacío y la primera
     * impresión del SaaS sería mentira.
     */
    const { servicio, lineas } = armar([], {
      GUPSHUP_SOURCE_NUMBER: '50433030235',
      GUPSHUP_APP_NAME: 'Linea100App',
    });

    await servicio.listar();

    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({
      cliente: 'AMDC',
      numero: '+50433030235',
      destino: 'Linea100App',
      agente: 'ag-entorno',
    });
  });

  it('cambiar el agente de una línea también lo deja listo', async () => {
    const { servicio, puestos, lineas } = armar([{ ...LINEA_100 }]);

    await servicio.actualizar('l1', { agente: 'ag-nuevo' });

    expect(puestos).toEqual(['ag-nuevo']);
    expect(lineas[0]['agente']).toBe('ag-nuevo');
  });
});
