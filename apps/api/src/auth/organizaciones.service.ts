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
  /** Código estable de cliente: lo que va en la factura y se dicta por teléfono. */
  codigo: string;
  nombre: string;
  plan: string;
  /**
   * `cliente` o `proveedor`. El proveedor somos nosotros, y es lo que
   * habilita ver TODO. Va en una columna del servidor y no en un rol
   * porque un rol se puede cambiar desde la pantalla de equipo: cualquier
   * administrador se ascendería a dueño de la plataforma.
   */
  tipo: 'cliente' | 'proveedor';
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
    /*
     * Sin base, UNA organización fija de desarrollo.
     *
     * Las organizaciones existen para aislar datos entre empresas, y el
     * aislamiento vive en el SQL: sin Postgres, el Brain usa el almacén de
     * archivo, que no filtra por nadie. Exigir base acá no agregaba
     * seguridad —no hay nada que separar— y dejaba el alta rota en local,
     * o sea imposible abrir la app recién clonada.
     *
     * En producción siempre hay base, así que este camino no se toma.
     */
    if (!this.pool) {
      this.logger.warn(`Sin DATABASE_URL: «${nombre}» entra a la organización local de desarrollo`);
      return 'org-local';
    }

    const pool = this.pool;
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
    return f ? OrganizacionesService.aOrganizacion(f) : null;
  }

  /** Todas las empresas. Solo la usa el back-office de la plataforma. */
  async listar(): Promise<Organizacion[]> {
    if (!this.pool) return [];
    await ensureSchema(this.pool);
    const r = await this.pool.query('SELECT * FROM organizaciones ORDER BY creada DESC');
    return r.rows.map((f) => OrganizacionesService.aOrganizacion(f));
  }

  private static aOrganizacion(f: Record<string, unknown>): Organizacion {
    return {
      id: String(f['id']),
      codigo: String(f['codigo'] ?? ''),
      nombre: String(f['nombre']),
      plan: String(f['plan']),
      tipo: f['tipo'] === 'proveedor' ? 'proveedor' : 'cliente',
      creada: new Date(String(f['creada'])).toISOString(),
    };
  }

  /**
   * Cambia el plan de una organización.
   *
   * Queda activo ya mismo, sin pasar por una pasarela: todavía no hay una,
   * y el cobro se emite por factura. Es deliberado — un checkout de mentira
   * que diga «pago aprobado» sin cobrar nada es peor que no tenerlo, porque
   * el cliente cree que pagó.
   *
   * Bajar de plan también es inmediato. Lo que ya se consumió del mes no se
   * devuelve: se midió con el precio de ese momento y esa fila no se toca.
   */
  async cambiarPlan(id: string, plan: string): Promise<void> {
    const pool = this.exigirBase();
    await ensureSchema(pool);
    const r = await pool.query('UPDATE organizaciones SET plan = $2 WHERE id = $1', [id, plan]);
    if (!r.rowCount) throw new ServiceUnavailableException('No se encontró la empresa de tu cuenta.');
    this.logger.log(`Plan de ${id}: ${plan}`);
  }

  /**
   * Borra una empresa. Solo si ya no le queda nadie adentro.
   *
   * Existe porque una empresa sin usuarios no se puede alcanzar desde
   * ninguna pantalla: nadie puede entrar a ella, así que nadie puede
   * borrarla. Son filas que se acumulan para siempre — y la primera la
   * dejé yo probando el alta.
   *
   * La comprobación de que está vacía NO va acá sino en quien llama, que
   * es el único que sabe contar usuarios. Acá va el borrado y nada más.
   */
  async eliminar(id: string): Promise<boolean> {
    if (!this.pool) return false;
    await ensureSchema(this.pool);
    const r = await this.pool.query('DELETE FROM organizaciones WHERE id = $1', [id]);
    if (r.rowCount) this.logger.warn(`Empresa eliminada: ${id}`);
    return !!r.rowCount;
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
