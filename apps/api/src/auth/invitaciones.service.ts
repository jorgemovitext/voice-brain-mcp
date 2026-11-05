import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/**
 * Invitaciones: sumar un colega a TU organización.
 *
 * Ya no son la puerta de la consola —el alta es pública y cada quien crea su
 * propia empresa—, sino lo que significan en cualquier SaaS: traer gente al
 * espacio que ya tenés. Una empresa tiene varios usuarios y todos ven lo
 * mismo; eso es lo que la invitación otorga.
 *
 * Por eso la organización viaja en la invitación y no se elige al
 * registrarse: quien tiene el código entra a la empresa de quien lo generó,
 * y no a una que pueda nombrar él.
 */

/** Horas de vida de una invitación sin usar. */
const VIGENCIA_HORAS = 72;

export interface Invitacion {
  id: string;
  /** A quién se la dieron, si se anotó. Nunca es un control de acceso. */
  phone?: string;
  nota?: string;
  creada: string;
  expira: string;
  usada?: string;
  /** `true` mientras sirva para registrarse. */
  vigente: boolean;
}

@Injectable()
export class InvitacionesService {
  private readonly logger = new Logger(InvitacionesService.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  /** El código se guarda HASHEADO: filtrar la tabla no debe abrir la puerta. */
  private static hash(codigo: string): string {
    return createHash('sha256').update(codigo.trim().toUpperCase()).digest('hex');
  }

  /**
   * Legible por teléfono y sin caracteres que se confundan al dictarlo:
   * nada de O/0 ni I/1, que es como se pierde media invitación dictada.
   */
  private static nuevoCodigo(): string {
    const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(12);
    const letras = Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join('');
    return `${letras.slice(0, 4)}-${letras.slice(4, 8)}-${letras.slice(8, 12)}`;
  }

  /**
   * Crea una invitación y devuelve el código UNA sola vez.
   *
   * No se puede volver a leer: solo guardamos su hash. Si se pierde, se
   * genera otra — es más barato que guardar códigos en claro.
   */
  async crear(input: {
    phone?: string;
    nota?: string;
    creadaPor: string;
    organizacion: string;
  }): Promise<{ codigo: string; invitacion: Invitacion }> {
    const pool = this.exigirBase();
    await ensureSchema(pool);

    const codigo = InvitacionesService.nuevoCodigo();
    const id = randomUUID();
    const expira = new Date(Date.now() + VIGENCIA_HORAS * 3_600_000).toISOString();

    await pool.query(
      `INSERT INTO invitations (id, code_hash, phone, nota, creada_por, expira, organizacion_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        InvitacionesService.hash(codigo),
        input.phone ?? null,
        input.nota ?? null,
        input.creadaPor,
        expira,
        input.organizacion,
      ],
    );

    this.logger.log(`Invitación creada por ${input.creadaPor}${input.phone ? ` para ${input.phone}` : ''}`);
    return {
      codigo,
      invitacion: { id, phone: input.phone, nota: input.nota, creada: new Date().toISOString(), expira, vigente: true },
    };
  }

  async listar(org?: string): Promise<Invitacion[]> {
    if (!this.pool || !org) return [];
    await ensureSchema(this.pool);
    const r = await this.pool.query(
      'SELECT * FROM invitations WHERE organizacion_id = $1 ORDER BY creada DESC LIMIT 50',
      [org],
    );
    const ahora = Date.now();
    return r.rows.map((f: Record<string, unknown>) => ({
      id: String(f['id']),
      phone: (f['phone'] as string | null) ?? undefined,
      nota: (f['nota'] as string | null) ?? undefined,
      creada: new Date(String(f['creada'])).toISOString(),
      expira: new Date(String(f['expira'])).toISOString(),
      usada: f['usada'] ? new Date(String(f['usada'])).toISOString() : undefined,
      vigente: !f['usada'] && new Date(String(f['expira'])).getTime() > ahora,
    }));
  }

  async revocar(id: string, org: string): Promise<void> {
    const pool = this.exigirBase();
    await ensureSchema(pool);
    // Con la organización en el WHERE: sin eso, el id de una invitación
    // ajena —que se puede adivinar— revocaría la de otra empresa.
    // Se marca usada en vez de borrarla: queda el rastro de que existió.
    await pool.query(
      `UPDATE invitations SET usada = now(), usada_por = 'revocada'
        WHERE id = $1 AND organizacion_id = $2 AND usada IS NULL`,
      [id, org],
    );
  }

  /**
   * Canjea el código. Devuelve el id de la invitación o lanza con el motivo.
   *
   * El UPDATE condicional es el que hace el canje ATÓMICO: dos registros
   * simultáneos con el mismo código compiten por la misma fila y solo uno se
   * la lleva. Comprobar y después marcar dejaría la ventana para que el
   * segundo entrara también.
   */
  async canjear(codigo: string, usuarioId: string): Promise<{ id: string; organizacion: string }> {
    const pool = this.exigirBase();
    await ensureSchema(pool);

    const limpio = (codigo ?? '').trim();
    if (!limpio) throw new BadRequestException('Falta el código de invitación.');

    const r = await pool.query(
      `UPDATE invitations SET usada = now(), usada_por = $2
        WHERE code_hash = $1 AND usada IS NULL AND expira > now()
        RETURNING id, organizacion_id`,
      [InvitacionesService.hash(limpio), usuarioId],
    );
    if (!r.rows[0]) {
      // Un solo mensaje para «no existe», «ya se usó» y «venció»: distinguirlos
      // le diría a quien prueba códigos cuáles existen.
      throw new BadRequestException('El código de invitación no es válido o ya venció.');
    }
    return { id: String(r.rows[0].id), organizacion: String(r.rows[0].organizacion_id) };
  }

  /** Comparación en tiempo constante, por si algún día se compara en memoria. */
  static iguales(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }

  private exigirBase(): Pool {
    if (!this.pool) {
      throw new BadRequestException('Las invitaciones necesitan base de datos (falta DATABASE_URL).');
    }
    return this.pool;
  }
}
