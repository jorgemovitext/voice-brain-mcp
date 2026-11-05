import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/**
 * Las organizaciones: una empresa, con varios usuarios adentro.
 *
 * Es la unidad de AISLAMIENTO de Hive. Quien se registra crea la suya y la
 * estrena vacía; quien llega con invitación entra a una que ya existe. Todo
 * lo demás —contactos, conversaciones, líneas, agentes— cuelga de acá, y esa
 * es la única razón por la que el alta puede ser pública sin regalar los
 * datos de los clientes que ya están.
 */

export interface Organizacion {
  id: string;
  nombre: string;
  plan: string;
  creada: string;
}

@Injectable()
export class OrganizacionesService {
  private readonly logger = new Logger(OrganizacionesService.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  /**
   * Crea la organización de quien se acaba de registrar.
   *
   * El nombre es el que la persona escribió; si no escribió nada, el que
   * tengamos. No se valida que sea único: dos clínicas pueden llamarse
   * «Clínica San Jorge» y no son la misma empresa — forzar unicidad le
   * negaría el alta a la segunda por un motivo que no entiende.
   */
  async crear(nombre: string): Promise<string> {
    const pool = this.exigirBase();
    await ensureSchema(pool);

    const id = `org-${randomUUID()}`;
    await pool.query(`INSERT INTO organizaciones (id, nombre, plan) VALUES ($1, $2, 'prueba')`, [
      id,
      (nombre || 'Mi empresa').trim().slice(0, 120),
    ]);
    this.logger.log(`Organización creada: ${nombre} (${id})`);
    return id;
  }

  async leer(id: string): Promise<Organizacion | null> {
    if (!this.pool) return null;
    await ensureSchema(this.pool);
    const r = await this.pool.query('SELECT * FROM organizaciones WHERE id = $1', [id]);
    const f = r.rows[0];
    return f
      ? {
          id: String(f.id),
          nombre: String(f.nombre),
          plan: String(f.plan),
          creada: new Date(String(f.creada)).toISOString(),
        }
      : null;
  }

  async renombrar(id: string, nombre: string): Promise<void> {
    const pool = this.exigirBase();
    await pool.query('UPDATE organizaciones SET nombre = $2 WHERE id = $1', [
      id,
      nombre.trim().slice(0, 120),
    ]);
  }

  private exigirBase(): Pool {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'No se puede crear la cuenta sin base de datos (falta DATABASE_URL).',
      );
    }
    return this.pool;
  }
}
