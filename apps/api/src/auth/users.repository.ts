import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';
import { Rol } from './permisos';

export interface AuthUser {
  id: string;
  /** Identificador de acceso. El teléfono ya no identifica: solo recibe el OTP. */
  username?: string;
  phone: string; // E.164 — destino del OTP
  name?: string;
  passwordHash: string;
  verified: boolean;
  failedLogins: number;
  lockedUntil?: string;
  otpHash?: string;
  otpExpiresAt?: string;
  otpAttempts: number;
  otpLastSentAt?: string;
  createdAt: string;
  /**
   * Desde cuándo valen los tokens de esta cuenta.
   *
   * Un JWT no se puede revocar: una vez firmado vale hasta que expira, y
   * con sesiones de 12 h eso es medio día de acceso para alguien a quien ya
   * le quitaron la cuenta. Adelantar esta marca mata todos sus tokens.
   */
  tokensDesde?: string;
  /** La empresa a la que pertenece. Varios usuarios comparten una. */
  organizacionId?: string;
  /**
   * Qué puede tocar. El primero de una empresa es su administrador: alguien
   * tiene que poder invitar y configurar, y si nadie pudiera, la cuenta
   * nace muerta. Los demás entran como usuarios — ver `permisos.ts`.
   */
  rol?: Rol;
}

export interface UsersRepository {
  findByUsername(username: string): Promise<AuthUser | undefined>;
  findByPhone(phone: string): Promise<AuthUser | undefined>;
  findById(id: string): Promise<AuthUser | undefined>;
  save(user: AuthUser): Promise<AuthUser>;
  /** Cuántas cuentas hay. Cero habilita el alta de arranque. */
  contar(): Promise<number>;
  /** Las de UNA organización, para la pantalla de equipo. Sin hashes. */
  listar(org?: string): Promise<AuthUser[]>;
  eliminar(id: string): Promise<boolean>;
}

export const USERS_REPOSITORY = 'UsersRepository';

/** Usuarios en Postgres — el modo real (prod). */
@Injectable()
export class PgUsersRepository implements UsersRepository {
  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  private async db(): Promise<Pool> {
    if (!this.pool) throw new Error('PgUsersRepository sin DATABASE_URL configurada');
    await ensureSchema(this.pool);
    return this.pool;
  }

  private rowToUser(r: Record<string, unknown>): AuthUser {
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
    return {
      id: r['id'] as string,
      username: (r['username'] as string | null) ?? undefined,
      phone: r['phone'] as string,
      name: (r['name'] as string | null) ?? undefined,
      passwordHash: r['password_hash'] as string,
      verified: r['verified'] as boolean,
      failedLogins: r['failed_logins'] as number,
      lockedUntil: iso(r['locked_until']),
      otpHash: (r['otp_hash'] as string | null) ?? undefined,
      otpExpiresAt: iso(r['otp_expires_at']),
      otpAttempts: r['otp_attempts'] as number,
      otpLastSentAt: iso(r['otp_last_sent_at']),
      createdAt: iso(r['created_at']) ?? new Date().toISOString(),
      tokensDesde: iso(r['tokens_desde']),
      organizacionId: (r['organizacion_id'] as string | null) ?? undefined,
      // Un rol que no reconocemos cae en el más limitado, nunca en admin:
      // una fila vieja o escrita a mano no puede ascender a nadie.
      rol: r['rol'] === 'admin' ? 'admin' : 'usuario',
    };
  }

  async findByUsername(username: string): Promise<AuthUser | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    return res.rows[0] ? this.rowToUser(res.rows[0]) : undefined;
  }

  async findByPhone(phone: string): Promise<AuthUser | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return res.rows[0] ? this.rowToUser(res.rows[0]) : undefined;
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    const db = await this.db();
    const res = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToUser(res.rows[0]) : undefined;
  }

  async save(user: AuthUser): Promise<AuthUser> {
    const db = await this.db();
    await db.query(
      `INSERT INTO users (id, username, phone, name, password_hash, verified, failed_logins, locked_until,
                          otp_hash, otp_expires_at, otp_attempts, otp_last_sent_at, created_at,
                          tokens_desde, organizacion_id, rol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         phone = EXCLUDED.phone,
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         verified = EXCLUDED.verified,
         failed_logins = EXCLUDED.failed_logins,
         locked_until = EXCLUDED.locked_until,
         otp_hash = EXCLUDED.otp_hash,
         otp_expires_at = EXCLUDED.otp_expires_at,
         otp_attempts = EXCLUDED.otp_attempts,
         otp_last_sent_at = EXCLUDED.otp_last_sent_at,
         tokens_desde = EXCLUDED.tokens_desde,
         organizacion_id = EXCLUDED.organizacion_id,
         rol = EXCLUDED.rol`,
      [
        user.id,
        user.username ?? null,
        user.phone,
        user.name ?? null,
        user.passwordHash,
        user.verified,
        user.failedLogins,
        user.lockedUntil ?? null,
        user.otpHash ?? null,
        user.otpExpiresAt ?? null,
        user.otpAttempts,
        user.otpLastSentAt ?? null,
        user.createdAt,
        user.tokensDesde ?? null,
        user.organizacionId ?? null,
        user.rol ?? 'usuario',
      ],
    );
    return user;
  }

  async contar(): Promise<number> {
    const db = await this.db();
    const r = await db.query('SELECT count(*)::int AS n FROM users');
    return r.rows[0]?.n ?? 0;
  }

  async listar(org?: string): Promise<AuthUser[]> {
    const db = await this.db();
    // Sin organización no devuelve NADA: un listado que ignora el filtro es
    // justo el que muestra el equipo de otra empresa.
    if (!org) return [];
    const r = await db.query(
      'SELECT * FROM users WHERE organizacion_id = $1 ORDER BY created_at ASC',
      [org],
    );
    return r.rows.map((row) => this.rowToUser(row));
  }

  async eliminar(id: string): Promise<boolean> {
    const db = await this.db();
    const r = await db.query('DELETE FROM users WHERE id = $1', [id]);
    return !!r.rowCount;
  }
}

/**
 * Respaldo en archivo JSON — SOLO desarrollo local sin Postgres. En serverless
 * el archivo vive en /tmp y muere con la instancia, por eso prod exige DB.
 */
@Injectable()
export class JsonUsersRepository implements UsersRepository {
  private readonly file: string;
  private users: AuthUser[] | null = null;

  constructor(config: ConfigService) {
    this.file = config.get<string>('AUTH_USERS_FILE', './data/users.json');
  }

  private async load(): Promise<AuthUser[]> {
    if (this.users) return this.users;
    try {
      this.users = JSON.parse(await fs.readFile(this.file, 'utf8')) as AuthUser[];
    } catch {
      this.users = [];
    }
    return this.users;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
    await fs.writeFile(this.file, JSON.stringify(this.users ?? [], null, 2));
  }

  async findByUsername(username: string): Promise<AuthUser | undefined> {
    return (await this.load()).find((u) => u.username === username);
  }

  async findByPhone(phone: string): Promise<AuthUser | undefined> {
    return (await this.load()).find((u) => u.phone === phone);
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    return (await this.load()).find((u) => u.id === id);
  }

  async save(user: AuthUser): Promise<AuthUser> {
    const users = await this.load();
    const idx = users.findIndex((u) => u.id === user.id);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    await this.persist();
    return user;
  }

  async contar(): Promise<number> {
    return (await this.load()).length;
  }

  async listar(): Promise<AuthUser[]> {
    return [...(await this.load())];
  }

  async eliminar(id: string): Promise<boolean> {
    const users = await this.load();
    const i = users.findIndex((u) => u.id === id);
    if (i < 0) return false;
    users.splice(i, 1);
    await this.persist();
    return true;
  }
}
