import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from '../shared/database.module';

export interface AuthUser {
  id: string;
  phone: string; // E.164 — identidad de login y destino del OTP
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
}

export interface UsersRepository {
  findByPhone(phone: string): Promise<AuthUser | undefined>;
  findById(id: string): Promise<AuthUser | undefined>;
  save(user: AuthUser): Promise<AuthUser>;
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
    };
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
      `INSERT INTO users (id, phone, name, password_hash, verified, failed_logins, locked_until,
                          otp_hash, otp_expires_at, otp_attempts, otp_last_sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         phone = EXCLUDED.phone,
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         verified = EXCLUDED.verified,
         failed_logins = EXCLUDED.failed_logins,
         locked_until = EXCLUDED.locked_until,
         otp_hash = EXCLUDED.otp_hash,
         otp_expires_at = EXCLUDED.otp_expires_at,
         otp_attempts = EXCLUDED.otp_attempts,
         otp_last_sent_at = EXCLUDED.otp_last_sent_at`,
      [
        user.id,
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
      ],
    );
    return user;
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
}
