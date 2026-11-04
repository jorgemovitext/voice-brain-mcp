import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AgenteActivoService } from '../shared/agente-activo.service';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/**
 * Las LÍNEAS: la unidad en la que Hive se vende.
 *
 * Una línea es el número de WhatsApp de un cliente y el agente que lo
 * atiende. Es la pieza que convierte el prototipo en SaaS: hasta acá había
 * UN número y UN agente activo globales; desde acá, cada mensaje entrante se
 * enruta por el número al que el ciudadano escribió, y cada cliente puede
 * tener su número con su agente sin enterarse de que existen los demás.
 *
 * Por ahora el canal es solo WhatsApp — decisión del arranque de la etapa.
 * El modelo no lo impide después (la columna sería `canal`), pero hoy no se
 * le cobra a nadie por un campo que nadie usa.
 */

export interface Linea {
  id: string;
  /** El negocio dueño del número: «AMDC», «Clínica San Jorge». */
  cliente: string;
  /** Cómo llama el equipo a esta línea: «Línea 100», «Citas Tegucigalpa». */
  nombre: string;
  /** E.164 con `+`. Único: un número no puede atenderlo dos agentes. */
  numero: string;
  /**
   * Clave extra de routing para cuando el webhook no trae el número: el
   * nombre de app de Gupshup. Opcional; el número manda.
   */
  destino?: string;
  /** El agente de ElevenLabs que atiende. La consola muestra su nombre, no esto. */
  agente: string;
  estado: 'activa' | 'pausada';
  creado: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;

@Injectable()
export class LineasService {
  private readonly logger = new Logger(LineasService.name);
  /** Promesa compartida: la siembra corre UNA vez aunque lleguen en ráfaga. */
  private sembrada: Promise<void> | null = null;

  constructor(
    /*
     * Null en desarrollo local sin DATABASE_URL. Sin base, las líneas se
     * degradan a «no hay ninguna»: el routing cae al agente activo global
     * (el comportamiento de siempre) y el alta avisa en vez de reventar.
     * En memoria no se simula a propósito: una línea que desaparece en cada
     * reinicio parecería un bug del routing, no una limitación del entorno.
     */
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    private readonly activo: AgenteActivoService,
    private readonly config: ConfigService,
  ) {}

  async listar(): Promise<Linea[]> {
    if (!this.pool) return [];
    await this.prepararTabla();
    const r = await this.pool!.query('SELECT * FROM lineas ORDER BY creado ASC');
    return r.rows.map(LineasService.aLinea);
  }

  /**
   * A qué agente le toca un mensaje que entró por `destino`.
   *
   * El destino puede venir como número (formato Meta) o como nombre de app
   * (formato Gupshup). Si ninguna línea coincide, se devuelve null y el que
   * llama cae al agente activo global: los webhooks del número histórico
   * siguen funcionando aunque nadie haya dado de alta su línea todavía.
   * Una línea PAUSADA no atiende: devuelve null a propósito.
   */
  async agenteDe(destino?: string): Promise<{ agente: string; linea: string } | null> {
    if (!this.pool || !destino?.trim()) return null;
    await this.prepararTabla();

    const digitos = destino.replace(/\D/g, '');
    const r = await this.pool!.query(
      `SELECT id, agente FROM lineas
        WHERE estado = 'activa'
          AND (destino = $1 OR ($2 <> '' AND regexp_replace(numero, '\\D', '', 'g') = $2))
        LIMIT 1`,
      [destino.trim(), digitos],
    );
    const fila = r.rows[0];
    return fila ? { agente: fila.agente, linea: fila.id } : null;
  }

  async crear(input: {
    cliente: string;
    nombre: string;
    numero: string;
    agente: string;
    destino?: string;
  }): Promise<Linea> {
    if (!this.pool) {
      throw new ServiceUnavailableException('Sin base de datos no hay dónde guardar la línea (falta DATABASE_URL).');
    }
    await this.prepararTabla();

    const numero = input.numero.replace(/[\s-]/g, '');
    if (!E164.test(numero)) {
      throw new BadRequestException('El número va en formato internacional, por ejemplo +50433030235.');
    }
    const cliente = input.cliente.trim();
    const nombre = input.nombre.trim();
    const agente = input.agente.trim();
    if (!cliente || !nombre || !agente) {
      throw new BadRequestException('Faltan el cliente, el nombre de la línea o el agente.');
    }

    /*
     * El agente queda LISTO al asignarle la línea, no al primer mensaje:
     * poner() habilita los permisos de override que el motor exige. Es la
     * misma lección de Movi — un agente elegido para atender sin los
     * permisos muere en silencio con cada mensaje — aplicada por línea.
     * Lo único que poner() hace de más es fijar el activo global, que hoy
     * es el respaldo para destinos sin línea: inofensivo mientras la Línea
     * 100 sea la primera, y desaparece cuando el routing sea solo por línea.
     */
    await this.activo.poner(agente);

    const linea: Linea = {
      id: randomUUID(),
      cliente,
      nombre,
      numero,
      destino: input.destino?.trim() || undefined,
      agente,
      estado: 'activa',
      creado: new Date().toISOString(),
    };

    try {
      await this.pool!.query(
        `INSERT INTO lineas (id, cliente, nombre, numero, destino, agente, estado, creado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [linea.id, cliente, nombre, numero, linea.destino ?? null, agente, linea.estado, linea.creado],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestException(`El número ${numero} ya tiene una línea. Editá esa en vez de crear otra.`);
      }
      throw err;
    }

    this.logger.log(`Línea creada: ${cliente} · ${nombre} · ${numero}`);
    return linea;
  }

  async actualizar(
    id: string,
    cambios: Partial<Pick<Linea, 'cliente' | 'nombre' | 'agente' | 'estado' | 'destino'>>,
  ): Promise<void> {
    if (!this.pool) throw new ServiceUnavailableException('Sin base de datos (falta DATABASE_URL).');
    await this.prepararTabla();
    const actual = await this.pool.query('SELECT * FROM lineas WHERE id = $1', [id]);
    if (!actual.rows[0]) throw new NotFoundException('Esa línea no existe.');

    if (cambios.estado && !['activa', 'pausada'].includes(cambios.estado)) {
      throw new BadRequestException('El estado es «activa» o «pausada».');
    }

    const fila = actual.rows[0];
    const agente = cambios.agente?.trim() || fila.agente;
    // Cambiar de agente también lo deja listo para contestar (permisos).
    if (agente !== fila.agente) await this.activo.poner(agente);

    await this.pool!.query(
      `UPDATE lineas SET cliente = $2, nombre = $3, agente = $4, estado = $5, destino = $6 WHERE id = $1`,
      [
        id,
        cambios.cliente?.trim() || fila.cliente,
        cambios.nombre?.trim() || fila.nombre,
        agente,
        cambios.estado ?? fila.estado,
        cambios.destino !== undefined ? cambios.destino.trim() || null : fila.destino,
      ],
    );
    this.logger.log(`Línea ${id} actualizada`);
  }

  async eliminar(id: string): Promise<void> {
    if (!this.pool) throw new ServiceUnavailableException('Sin base de datos (falta DATABASE_URL).');
    await this.prepararTabla();
    const r = await this.pool!.query('DELETE FROM lineas WHERE id = $1', [id]);
    if (!r.rowCount) throw new NotFoundException('Esa línea no existe.');
    this.logger.warn(`Línea ${id} eliminada`);
  }

  /**
   * La primera vez siembra la Línea 100 con el número que ya atiende.
   *
   * Sin la siembra, el día del deploy la tabla está vacía, ningún destino
   * coincide y todo cae al agente activo global: funciona, pero la pantalla
   * de Canales aparecería vacía cuando hay una línea REAL en producción, y
   * la primera impresión del SaaS sería mentira.
   */
  private prepararTabla(): Promise<void> {
    if (!this.sembrada) {
      const pool = this.pool!;
      this.sembrada = (async () => {
        await ensureSchema(pool);

        const hay = await pool.query('SELECT 1 FROM lineas LIMIT 1');
        if (hay.rows.length) return;

        const numero = this.config.get<string>('GUPSHUP_SOURCE_NUMBER', '').trim();
        if (!numero) return;

        const agente = await this.activo.id().catch(() => '');
        if (!agente) return;

        await pool.query(
          `INSERT INTO lineas (id, cliente, nombre, numero, destino, agente, estado, creado)
           VALUES ($1, $2, $3, $4, $5, $6, 'activa', now())
           ON CONFLICT (numero) DO NOTHING`,
          [
            randomUUID(),
            'AMDC',
            'Línea 100',
            numero.startsWith('+') ? numero : `+${numero}`,
            this.config.get<string>('GUPSHUP_APP_NAME', '').trim() || null,
            agente,
          ],
        );
        this.logger.log('Línea 100 sembrada desde la configuración existente');
      })().catch((err) => {
        // El próximo intento vuelve a probar: una base caída al arrancar no
        // puede dejar la siembra cancelada para siempre.
        this.sembrada = null;
        throw err;
      });
    }
    return this.sembrada;
  }

  private static aLinea(r: Record<string, unknown>): Linea {
    return {
      id: String(r['id']),
      cliente: String(r['cliente']),
      nombre: String(r['nombre']),
      numero: String(r['numero']),
      destino: (r['destino'] as string | null) ?? undefined,
      agente: String(r['agente']),
      estado: r['estado'] === 'pausada' ? 'pausada' : 'activa',
      creado: new Date(String(r['creado'])).toISOString(),
    };
  }
}
