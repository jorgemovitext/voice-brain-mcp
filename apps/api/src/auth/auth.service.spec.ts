import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { OtpSender } from './otp.sender';
import { AuthUser, UsersRepository } from './users.repository';

/**
 * Pruebas de seguridad del flujo register/login/OTP:
 * hashing, lockout, expiración y límite de intentos del OTP,
 * un solo uso, y respuestas sin enumeración de usuarios.
 */

class MemoryUsers implements UsersRepository {
  users: AuthUser[] = [];
  async findByPhone(phone: string) {
    return this.users.find((u) => u.phone === phone);
  }
  async findById(id: string) {
    return this.users.find((u) => u.id === id);
  }
  async save(user: AuthUser) {
    const idx = this.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) this.users[idx] = user;
    else this.users.push(user);
    return user;
  }
}

class CaptureOtp {
  sent: Array<{ phone: string; code: string }> = [];
  async send(phone: string, code: string) {
    this.sent.push({ phone, code });
  }
  get last(): string {
    return this.sent[this.sent.length - 1]?.code ?? '';
  }
}

const PHONE = '+50499990000';
const PASSWORD = 'segura123';

function build() {
  const users = new MemoryUsers();
  const otp = new CaptureOtp();
  const config = {
    get: (key: string, def?: unknown) =>
      ({ AUTH_OTP_TTL_MIN: 5, AUTH_SESSION_HOURS: 12 } as Record<string, unknown>)[key] ?? def,
  };
  const service = new AuthService(
    users,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    otp as unknown as OtpSender,
    config as never,
  );
  return { service, users, otp };
}

/** Registro + verificación completos: deja un usuario listo para login. */
async function registered(ctx: ReturnType<typeof build>) {
  await ctx.service.register(PHONE, PASSWORD, 'Jorge');
  await ctx.service.verifyOtp(PHONE, ctx.otp.last);
}

describe('AuthService (seguridad)', () => {
  it('registra, envía OTP y la verificación abre sesión', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD, 'Jorge');
    expect(ctx.otp.sent).toHaveLength(1);
    expect(ctx.otp.last).toMatch(/^\d{6}$/);

    const { token, user } = await ctx.service.verifyOtp(PHONE, ctx.otp.last);
    expect(token.length).toBeGreaterThan(20);
    expect(user.phone).toBe(PHONE);
    expect(ctx.users.users[0].verified).toBe(true);
    // El código no queda en texto plano en el almacén.
    expect(JSON.stringify(ctx.users.users)).not.toContain(ctx.otp.last);
  });

  it('el hash de contraseña no es reversible ni acepta contraseñas equivocadas', async () => {
    const ctx = build();
    const hash = await ctx.service.hashPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(await ctx.service.verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await ctx.service.verifyPassword('otraClave1', hash)).toBe(false);
  });

  it('login correcto exige el segundo factor (OTP)', async () => {
    const ctx = build();
    await registered(ctx);
    const res = await ctx.service.login(PHONE, PASSWORD);
    expect(res).toEqual({ otpRequired: true });
    // Sin verificar el OTP nuevo no hay token: verify con código viejo falla.
    await expect(ctx.service.verifyOtp(PHONE, '000000')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mismo mensaje de error para usuario inexistente y contraseña mala (anti-enumeración)', async () => {
    const ctx = build();
    await registered(ctx);
    const e1 = await ctx.service.login('+50488887777', 'loQueSea1').catch((e) => e.message);
    const e2 = await ctx.service.login(PHONE, 'contraseñaMala1').catch((e) => e.message);
    expect(e1).toBe(e2);
  });

  it('bloquea la cuenta tras 5 contraseñas fallidas', async () => {
    const ctx = build();
    await registered(ctx);
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.login(PHONE, 'incorrecta9')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(ctx.users.users[0].lockedUntil).toBeDefined();
    // Incluso con la contraseña buena, bloqueado = mismo error genérico.
    await expect(ctx.service.login(PHONE, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP expira', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD);
    ctx.users.users[0].otpExpiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(ctx.service.verifyOtp(PHONE, ctx.otp.last)).rejects.toBeInstanceOf(UnauthorizedException);
    // Y quedó invalidado: reintentar con el mismo código tampoco entra.
    await expect(ctx.service.verifyOtp(PHONE, ctx.otp.last)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP admite máximo 5 intentos y luego queda inutilizado', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD);
    const bueno = ctx.otp.last;
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.verifyOtp(PHONE, '999999')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // El sexto intento con el código CORRECTO también falla (se agotó).
    await expect(ctx.service.verifyOtp(PHONE, bueno)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP es de un solo uso', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD);
    const code = ctx.otp.last;
    await ctx.service.verifyOtp(PHONE, code);
    await expect(ctx.service.verifyOtp(PHONE, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reenvío dentro del cooldown no genera código nuevo', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD);
    expect(ctx.otp.sent).toHaveLength(1);
    await ctx.service.resendOtp(PHONE); // inmediato: dentro de los 60 s
    expect(ctx.otp.sent).toHaveLength(1);
  });

  it('registro sobre un número YA verificado no reenvía OTP ni cambia la contraseña', async () => {
    const ctx = build();
    await registered(ctx);
    const hashOriginal = ctx.users.users[0].passwordHash;
    const res = await ctx.service.register(PHONE, 'otraClave123');
    expect(res.message).toContain('Si el número está disponible');
    expect(ctx.otp.sent).toHaveLength(1); // solo el del registro original
    expect(ctx.users.users[0].passwordHash).toBe(hashOriginal);
  });

  it('un usuario sin verificar no puede hacer login con contraseña', async () => {
    const ctx = build();
    await ctx.service.register(PHONE, PASSWORD);
    await expect(ctx.service.login(PHONE, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
