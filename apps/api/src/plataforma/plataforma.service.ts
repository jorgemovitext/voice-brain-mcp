import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { MedicionService } from '../facturacion/medicion.service';
import { plan as planPorId } from '../facturacion/planes';
import { nombrePais } from '../facturacion/paises';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/**
 * El back-office: lo que ve el dueño del servicio y ningún cliente.
 *
 * Responde dos preguntas que hoy solo se contestaban entrando a la base:
 * quiénes son nuestros clientes y cuánto factura cada uno, abierto por
 * país — que es como se factura y como se reclama.
 *
 * Las consultas van DIRECTAS contra la base y sin el filtro por
 * organización a propósito: es el único lugar del sistema que debe cruzar
 * esa línea, y por eso está aislado en su propio módulo con su propia
 * puerta (`PlataformaGuard`). Mezclarlo con los servicios que usan los
 * clientes sería dejar una consulta sin filtro al alcance de un error.
 */

export interface ClienteResumen {
  id: string;
  codigo: string;
  nombre: string;
  plan: string;
  tipo: 'cliente' | 'proveedor';
  creada: string;
  usuarios: number;
  lineas: number;
  /** Del período en curso. */
  mensajes: number;
  facturado: number;
  costo: number;
}

export interface FilaPais {
  pais: string;
  nombrePais: string;
  prefijo?: string;
  canal: string;
  categoria: string;
  mensajes: number;
  facturado: number;
  costo: number;
}

@Injectable()
export class PlataformaService {
  private readonly logger = new Logger(PlataformaService.name);

  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    private readonly organizaciones: OrganizacionesService,
    private readonly medicion: MedicionService,
  ) {}

  /** Todos los clientes con su consumo del período. */
  async clientes(periodo = MedicionService.periodoDe()): Promise<ClienteResumen[]> {
    const empresas = await this.organizaciones.listar();
    if (!this.pool || !empresas.length) return [];

    await ensureSchema(this.pool);
    const [usuarios, lineas, consumo] = await Promise.all([
      this.pool.query(`SELECT organizacion_id AS org, count(*)::int AS n FROM users GROUP BY 1`),
      this.pool.query(`SELECT organizacion_id AS org, count(*)::int AS n FROM lineas GROUP BY 1`),
      this.pool.query(
        `SELECT organizacion_id AS org,
                sum(cantidad)::int AS mensajes,
                sum(precio_micros * cantidad)::bigint AS facturado,
                sum(costo_micros * cantidad)::bigint AS costo
           FROM consumo WHERE periodo = $1 GROUP BY 1`,
        [periodo],
      ),
    ]);

    const porOrg = <T>(filas: Array<Record<string, unknown>>, leer: (f: Record<string, unknown>) => T) =>
      new Map(filas.map((f) => [String(f['org']), leer(f)]));

    const u = porOrg(usuarios.rows, (f) => Number(f['n']));
    const l = porOrg(lineas.rows, (f) => Number(f['n']));
    const c = porOrg(consumo.rows, (f) => ({
      mensajes: Number(f['mensajes'] ?? 0),
      facturado: Number(f['facturado'] ?? 0),
      costo: Number(f['costo'] ?? 0),
    }));

    return empresas.map((e) => ({
      ...e,
      usuarios: u.get(e.id) ?? 0,
      lineas: l.get(e.id) ?? 0,
      mensajes: c.get(e.id)?.mensajes ?? 0,
      facturado: c.get(e.id)?.facturado ?? 0,
      costo: c.get(e.id)?.costo ?? 0,
    }));
  }

  /**
   * La ficha de un cliente: su gente, sus números y su factura por país.
   *
   * El desglose es por país Y por canal Y por categoría porque esas tres
   * cosas son las que mueven el precio. Agrupar solo por país daría un
   * total correcto con un detalle que no explica nada cuando alguien
   * pregunta por qué le cobramos lo que le cobramos.
   */
  async cliente(id: string, periodo = MedicionService.periodoDe()) {
    const empresa = await this.organizaciones.leer(id);
    if (!empresa || !this.pool) return null;

    await ensureSchema(this.pool);
    const [usuarios, cuentas, lineas, porPais, periodos] = await Promise.all([
      this.pool.query(
        `SELECT id, username, name, phone, rol, created_at FROM users
          WHERE organizacion_id = $1 ORDER BY created_at ASC`,
        [id],
      ),
      this.pool.query(`SELECT id, codigo, nombre, estado FROM cuentas WHERE organizacion_id = $1`, [id]),
      this.pool.query(
        `SELECT id, cliente, nombre, numero, agente, estado, proveedor FROM lineas
          WHERE organizacion_id = $1 ORDER BY creado ASC`,
        [id],
      ),
      this.pool.query(
        `SELECT pais, prefijo, canal, categoria,
                sum(cantidad)::int AS mensajes,
                sum(precio_micros * cantidad)::bigint AS facturado,
                sum(costo_micros * cantidad)::bigint AS costo
           FROM consumo WHERE organizacion_id = $1 AND periodo = $2
          GROUP BY pais, prefijo, canal, categoria
          ORDER BY facturado DESC`,
        [id, periodo],
      ),
      this.medicion.periodos(id),
    ]);

    const filas: FilaPais[] = porPais.rows.map((f) => ({
      pais: String(f['pais']),
      nombrePais: nombrePais(String(f['pais'])),
      prefijo: (f['prefijo'] as string | null) ?? undefined,
      canal: String(f['canal']),
      categoria: String(f['categoria']),
      mensajes: Number(f['mensajes']),
      facturado: Number(f['facturado']),
      costo: Number(f['costo']),
    }));

    const facturado = filas.reduce((t, f) => t + f.facturado, 0);
    const costo = filas.reduce((t, f) => t + f.costo, 0);

    return {
      empresa,
      plan: planPorId(empresa.plan),
      periodo,
      periodos,
      usuarios: usuarios.rows.map((f) => ({
        id: String(f['id']),
        username: (f['username'] as string | null) ?? undefined,
        nombre: (f['name'] as string | null) ?? undefined,
        // Completo, no enmascarado: es nuestro back-office y acá se soporta
        // al cliente por teléfono.
        telefono: String(f['phone']),
        rol: f['rol'] === 'admin' ? 'admin' : 'usuario',
        desde: new Date(String(f['created_at'])).toISOString(),
      })),
      cuentas: cuentas.rows.map((f) => ({
        id: String(f['id']),
        codigo: String(f['codigo']),
        nombre: String(f['nombre']),
        estado: String(f['estado']),
      })),
      lineas: lineas.rows.map((f) => ({
        id: String(f['id']),
        cliente: String(f['cliente']),
        nombre: String(f['nombre']),
        numero: String(f['numero']),
        agente: String(f['agente']),
        estado: String(f['estado']),
        proveedor: (f['proveedor'] as string | null) ?? 'gupshup',
      })),
      porPais: filas,
      facturado,
      costo,
      /** Lo que queda nuestro. Es el número que no se puede ver desde el cliente. */
      margen: facturado - costo,
    };
  }

  /**
   * El detalle crudo para facturar: una fila por envío.
   *
   * Es el mismo corte que ya se emite hoy —cliente, cuenta, prefijo, tipo,
   * cantidad— más lo que faltaba para auditar: el número, el canal, el
   * proveedor y los dos operadores de la portabilidad.
   */
  async detalle(org: string, periodo: string, limite = 5_000) {
    if (!this.pool) return [];
    await ensureSchema(this.pool);
    const r = await this.pool.query(
      `SELECT c.ocurrido, o.codigo AS cliente_codigo, o.nombre AS cliente,
              ct.codigo AS cuenta, c.canal, c.pais, c.prefijo, c.destino,
              c.categoria, c.cantidad, c.precio_micros, c.costo_micros,
              c.proveedor, c.operador_inicial, c.operador_final
         FROM consumo c
         JOIN organizaciones o ON o.id = c.organizacion_id
         LEFT JOIN cuentas ct ON ct.id = c.cuenta_id
        WHERE c.organizacion_id = $1 AND c.periodo = $2
        ORDER BY c.ocurrido ASC
        LIMIT $3`,
      [org, periodo, limite],
    );
    return r.rows.map((f) => ({
      fecha: new Date(String(f['ocurrido'])).toISOString(),
      clienteCodigo: String(f['cliente_codigo'] ?? ''),
      cliente: String(f['cliente']),
      cuenta: String(f['cuenta'] ?? ''),
      canal: String(f['canal']),
      pais: String(f['pais']),
      nombrePais: nombrePais(String(f['pais'])),
      prefijo: (f['prefijo'] as string | null) ?? '',
      telefono: (f['destino'] as string | null) ?? '',
      tipo: String(f['categoria']),
      cantidad: Number(f['cantidad']),
      facturado: Number(f['precio_micros']) * Number(f['cantidad']),
      costo: Number(f['costo_micros']) * Number(f['cantidad']),
      proveedor: (f['proveedor'] as string | null) ?? '',
      operadorInicial: (f['operador_inicial'] as string | null) ?? '',
      operadorFinal: (f['operador_final'] as string | null) ?? '',
    }));
  }
}
