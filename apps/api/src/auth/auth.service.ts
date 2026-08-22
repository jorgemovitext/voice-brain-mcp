import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { OtpSender } from './otp.sender';
import { AuthUser, USERS_REPOSITORY, UsersRepository } from './users.repository';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

/** Parámetros scrypt (memoria ~16 MB): fuertes y viables en serverless. */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;

const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_OTP_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_S = 60;

/**
 * Mensaje único para toda falla de credenciales/OTP: no revela si el número
 * existe, si la contraseña estaba mal o si la cuenta está bloqueada
 * (anti-enumeración de usuarios).
 */
const GENERIC_FAIL = 'Credenciales inválidas o cuenta bloqueada temporalmente.';

export interface SessionUser {
  id: string;
  phone: string;
  name?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly otpTtlMin: number;
  readonly sessionHours: number;

  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    private readonly otpSender: OtpSender,
    config: ConfigService,
  ) {
    this.otpTtlMin = config.get<number>('AUTH_OTP_TTL_MIN', 5);
    this.sessionHours = config.get<number>('AUTH_SESSION_HOURS', 12);
  }

  // =============== Password hashing (scrypt) ===============

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LEN);
    const hash = await scrypt(password, salt, KEY_LEN, SCRYPT);
    return `s2$${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 's2' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // =============== Registro ===============

  /**
   * Alta de usuario. La respuesta es SIEMPRE la misma exista o no el número
   * (anti-enumeración): si el número está libre o pendiente de verificar, se
   * crea/actualiza y se envía OTP; si ya está verificado, no se hace nada.
   */
  async register(phone: string, password: string, name?: string): Promise<{ message: string }> {
    const existing = await this.users.findByPhone(phone);

    if (existing?.verified) {
      // Número ya en uso: respuesta idéntica, sin OTP (el dueño real no
      // recibe spam y el atacante no aprende nada).
      this.logger.warn(`Registro sobre número ya verificado: ${phone.slice(0, 6)}…`);
    } else {
      const user: AuthUser = existing ?? {
        id: randomUUID(),
        phone,
        passwordHash: '',
        verified: false,
        failedLogins: 0,
        otpAttempts: 0,
        createdAt: new Date().toISOString(),
      };
      user.name = name ?? user.name;
      user.passwordHash = await this.hashPassword(password);
      await this.issueOtp(user);
    }

    return { message: 'Si el número está disponible, te enviamos un código por WhatsApp.' };
  }

  // =============== Login (password + OTP como segundo factor) ===============

  async login(phone: string, password: string): Promise<{ otpRequired: true }> {
    const user = await this.users.findByPhone(phone);

    // Usuario inexistente: se verifica contra un hash de sacrificio para que
    // el tiempo de respuesta no delate si el número existe.
    if (!user) {
      await this.verifyPassword(password, await this.dummyHash());
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      throw new UnauthorizedException(GENERIC_FAIL);
    }
    if (!user.verified) {
      // Registrado pero nunca verificó: que termine el registro.
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    const ok = await this.verifyPassword(password, user.passwordHash);
    if (!ok) {
      user.failedLogins += 1;
      if (user.failedLogins >= MAX_LOGIN_FAILS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
        user.failedLogins = 0;
        this.logger.warn(`Cuenta bloqueada ${LOCK_MINUTES} min por intentos fallidos: ${phone.slice(0, 6)}…`);
      }
      await this.users.save(user);
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    user.failedLogins = 0;
    await this.issueOtp(user);
    return { otpRequired: true };
  }

  // =============== OTP ===============

  private hashOtp(code: string, userId: string): string {
    // Ligado al userId para que un hash filtrado no sirva contra otra cuenta.
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }

  /** Genera, guarda (solo hash) y envía el código. Respeta el cooldown de reenvío. */
  private async issueOtp(user: AuthUser): Promise<void> {
    if (user.otpLastSentAt && Date.now() - new Date(user.otpLastSentAt).getTime() < OTP_RESEND_COOLDOWN_S * 1000) {
      // Dentro del cooldown no se reenvía; la respuesta externa no cambia.
      await this.users.save(user);
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    user.otpHash = this.hashOtp(code, user.id);
    user.otpExpiresAt = new Date(Date.now() + this.otpTtlMin * 60_000).toISOString();
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date().toISOString();
    await this.users.save(user);

    try {
      await this.otpSender.send(user.phone, code, this.otpTtlMin);
    } catch (err) {
      // El envío falló (canal caído): el código queda emitido y el error no
      // filtra nada; el usuario puede pedir reenvío pasado el cooldown.
      this.logger.error(`Fallo al entregar OTP: ${(err as Error).message}`);
    }
  }

  /** Reenvío explícito. Respuesta genérica exista o no el número. */
  async resendOtp(phone: string): Promise<{ message: string }> {
    const user = await this.users.findByPhone(phone);
    if (user) await this.issueOtp(user);
    return { message: 'Si el número está registrado, te reenviamos un código.' };
  }

  /**
   * Verifica el OTP y, si es válido, devuelve el JWT de sesión.
   * El código expira, admite 5 intentos y es de un solo uso.
   */
  async verifyOtp(phone: string, code: string): Promise<{ token: string; user: SessionUser }> {
    const user = await this.users.findByPhone(phone);
    if (!user?.otpHash || !user.otpExpiresAt) throw new UnauthorizedException(GENERIC_FAIL);

    if (new Date(user.otpExpiresAt).getTime() < Date.now()) {
      await this.clearOtp(user);
      throw new UnauthorizedException(GENERIC_FAIL);
    }
    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      await this.clearOtp(user);
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    const expected = Buffer.from(user.otpHash, 'hex');
    const actual = Buffer.from(this.hashOtp(code, user.id), 'hex');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!ok) {
      user.otpAttempts += 1;
      await this.users.save(user);
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    // Un solo uso + verificación del número si venía del registro.
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    user.otpAttempts = 0;
    user.verified = true;
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    await this.users.save(user);

    const sessionUser: SessionUser = { id: user.id, phone: user.phone, name: user.name };
    const token = await this.jwt.signAsync({ sub: user.id, phone: user.phone });
    return { token, user: sessionUser };
  }

  private async clearOtp(user: AuthUser): Promise<void> {
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    user.otpAttempts = 0;
    await this.users.save(user);
  }

  // =============== Sesión ===============

  async me(userId: string): Promise<SessionUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Sesión inválida');
    return { id: user.id, phone: user.phone, name: user.name };
  }

  /** Hash fijo para igualar tiempos cuando el usuario no existe. */
  private dummyPromise: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    this.dummyPromise ??= this.hashPassword(randomBytes(12).toString('hex'));
    return this.dummyPromise;
  }
}
