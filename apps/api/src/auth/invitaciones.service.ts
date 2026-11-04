import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';

/**
 * Invitaciones: la única puerta de alta a la consola.
 *
 * Hasta acá, `register` era público y entregaba sesión al instante. Eso no
 * era «un registro simple»: era una consola con datos de ciudadanos —
 * teléfonos, reportes, transcripciones— abierta a cualquiera que supiera la
 * URL. Se verificó contra producción: una cuenta creada desde afuera leía
 * /api/contacts sin más.
 *
 * El control es la INVITACIÓN y no el OTP, a propósito. El OTP viaja por
 * WhatsApp y WhatsApp solo entrega texto libre dentro de la ventana de 24 h:
 * exigirlo para entrar deja a un operador afuera por una regla de Meta, que
 * es exactamente lo que ya pasó. La invitación prueba que alguien de adentro
 * autorizó el alta; la contraseña prueba quién sos. El OTP queda para
 * recuperar el acceso, que es donde su demora no bloquea a nadie.
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
  async crear(input: { phone?: string; nota?: string; creadaPor: string }): Promise<{ codigo: string; invitacion: Invitacion }> {
    const pool = this.exigirBase();
    await ensureSchema(pool);

    const codigo = InvitacionesService.nuevoCodigo();
    const id = randomUUID();
    const expira = new Date(Date.now() + VIGENCIA_HORAS * 3_600_000).toISOString();

    await pool.query(
      `INSERT INTO invitations (id, code_hash, phone, nota, creada_por, expira)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, InvitacionesService.hash(codigo), input.phone ?? null, input.nota ?? null, input.creadaPor, expira],
    );

    this.logger.log(`Invitación creada por ${input.creadaPor}${input.phone ? ` para ${input.phone}` : ''}`);
    return {
      codigo,
      invitacion: { id, phone: input.phone, nota: input.nota, creada: new Date().toISOString(), expira, vigente: true },
    };
  }

  async listar(): Promise<Invitacion[]> {
    if (!this.pool) return [];
    await ensureSchema(this.pool);
    const r = await this.pool.query('SELECT * FROM invitations ORDER BY creada DESC LIMIT 50');
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

  async revocar(id: string): Promise<void> {
    const pool = this.exigirBase();
    await ensureSchema(pool);
    // Se marca usada en vez de borrarla: queda el rastro de que existió.
    await pool.query(`UPDATE invitations SET usada = now(), usada_por = 'revocada' WHERE id = $1 AND usada IS NULL`, [id]);
  }

  /**
   * Canjea el código. Devuelve el id de la invitación o lanza con el motivo.
   *
   * El UPDATE condicional es el que hace el canje ATÓMICO: dos registros
   * simultáneos con el mismo código compiten por la misma fila y solo uno se
   * la lleva. Comprobar y después marcar dejaría la ventana para que el
   * segundo entrara también.
   */
  async canjear(codigo: string, usuarioId: string): Promise<string> {
    const pool = this.exigirBase();
    await ensureSchema(pool);

    const limpio = (codigo ?? '').trim();
    if (!limpio) throw new BadRequestException('Falta el código de invitación.');

    const r = await pool.query(
      `UPDATE invitations SET usada = now(), usada_por = $2
        WHERE code_hash = $1 AND usada IS NULL AND expira > now()
        RETURNING id`,
      [InvitacionesService.hash(limpio), usuarioId],
    );
    if (!r.rows[0]) {
      // Un solo mensaje para «no existe», «ya se usó» y «venció»: distinguirlos
      // le diría a quien prueba códigos cuáles existen.
      throw new BadRequestException('El código de invitación no es válido o ya venció.');
    }
    return String(r.rows[0].id);
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
