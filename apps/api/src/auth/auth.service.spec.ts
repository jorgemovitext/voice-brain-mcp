import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
  async findByUsername(username: string) {
    return this.users.find((u) => u.username === username);
  }
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

const USER = 'jorge';
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

/** Deja un usuario listo para entrar. El registro ya abre sesión. */
async function registered(ctx: ReturnType<typeof build>) {
  await ctx.service.register(USER, PASSWORD, PHONE, 'Jorge');
}

/** Pone un OTP pendiente, que ahora solo nace del "entrar con código". */
async function conCodigo(ctx: ReturnType<typeof build>) {
  await ctx.service.resendOtp(USER);
}

describe('AuthService (seguridad)', () => {
  it('el registro abre sesión de una, sin código', async () => {
    const ctx = build();
    const { token, user } = await ctx.service.register(USER, PASSWORD, PHONE, 'Jorge');

    expect(token.length).toBeGreaterThan(20);
    expect(user.username).toBe(USER);
    expect(user.phone).toBe(PHONE);
    expect(ctx.otp.sent).toHaveLength(0);
  });

  it('no deja registrar sobre un usuario que ya existe', async () => {
    const ctx = build();
    await registered(ctx);
    const hashOriginal = ctx.users.users[0].passwordHash;

    await expect(ctx.service.register(USER, 'otraClave123', PHONE)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Y la contraseña del dueño real no se toca.
    expect(ctx.users.users[0].passwordHash).toBe(hashOriginal);
  });

  it('el hash de contraseña no es reversible ni acepta contraseñas equivocadas', async () => {
    const ctx = build();
    const hash = await ctx.service.hashPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(await ctx.service.verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await ctx.service.verifyPassword('otraClave1', hash)).toBe(false);
  });

  it('el login correcto abre sesión con usuario y contraseña', async () => {
    const ctx = build();
    await registered(ctx);

    const res = await ctx.service.login(USER, PASSWORD);
    expect(res.otpRequired).toBe(false);
    expect(res.token.length).toBeGreaterThan(20);
    expect(res.user.username).toBe(USER);
    // Entrar no manda ningún código.
    expect(ctx.otp.sent).toHaveLength(0);
  });

  it('mismo mensaje de error para usuario inexistente y contraseña mala (anti-enumeración)', async () => {
    const ctx = build();
    await registered(ctx);
    const e1 = await ctx.service.login('noexiste', 'loQueSea1').catch((e) => e.message);
    const e2 = await ctx.service.login(USER, 'contraseñaMala1').catch((e) => e.message);
    expect(e1).toBe(e2);
  });

  it('bloquea la cuenta tras 5 contraseñas fallidas', async () => {
    const ctx = build();
    await registered(ctx);
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.login(USER, 'incorrecta9')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(ctx.users.users[0].lockedUntil).toBeDefined();
    // Incluso con la contraseña buena, bloqueado = mismo error genérico.
    await expect(ctx.service.login(USER, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP expira', async () => {
    const ctx = build();
    await registered(ctx);
    await conCodigo(ctx);
    ctx.users.users[0].otpExpiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(ctx.service.verifyOtp(USER, ctx.otp.last)).rejects.toBeInstanceOf(UnauthorizedException);
    // Y quedó invalidado: reintentar con el mismo código tampoco entra.
    await expect(ctx.service.verifyOtp(USER, ctx.otp.last)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP admite máximo 5 intentos y luego queda inutilizado', async () => {
    const ctx = build();
    await registered(ctx);
    await conCodigo(ctx);
    const bueno = ctx.otp.last;
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.verifyOtp(USER, '999999')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // El sexto intento con el código CORRECTO también falla (se agotó).
    await expect(ctx.service.verifyOtp(USER, bueno)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el OTP es de un solo uso', async () => {
    const ctx = build();
    await registered(ctx);
    await conCodigo(ctx);
    const code = ctx.otp.last;
    await ctx.service.verifyOtp(USER, code);
    await expect(ctx.service.verifyOtp(USER, code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reenvío dentro del cooldown no genera código nuevo', async () => {
    const ctx = build();
    await registered(ctx);
    await conCodigo(ctx);
    expect(ctx.otp.sent).toHaveLength(1);
    await ctx.service.resendOtp(USER); // inmediato: dentro de los 60 s
    expect(ctx.otp.sent).toHaveLength(1);
  });

  it('una cuenta vieja sin username entra con su teléfono', async () => {
    const ctx = build();
    await registered(ctx);
    // Cuentas creadas cuando el teléfono era el identificador: sin username.
    ctx.users.users[0].username = undefined;

    const { user } = await ctx.service.login(PHONE, PASSWORD);
    expect(user.phone).toBe(PHONE);
  });

  it('asignar usuario exige la contraseña actual y deja entrar con el nombre nuevo', async () => {
    const ctx = build();
    await registered(ctx);
    const id = ctx.users.users[0].id;
    ctx.users.users[0].username = undefined; // cuenta vieja, sin usuario

    // Sin la contraseña correcta no se toca nada.
    await expect(ctx.service.setUsername(id, 'nuevo.user', 'claveMala1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(ctx.users.users[0].username).toBeUndefined();

    const perfil = await ctx.service.setUsername(id, 'nuevo.user', PASSWORD);
    expect(perfil.username).toBe('nuevo.user');

    // Y a partir de acá el login por usuario funciona.
    const res = await ctx.service.login('nuevo.user', PASSWORD);
    expect(res.user.username).toBe('nuevo.user');
  });

  it('no se puede tomar el usuario de otra cuenta', async () => {
    const ctx = build();
    await registered(ctx); // USER queda tomado por la primera cuenta

    // Segunda cuenta, con otro teléfono.
    await ctx.service.register('otro.user', PASSWORD, '+50411112222');
    const segunda = ctx.users.users.find((u) => u.username === 'otro.user')!;

    await expect(ctx.service.setUsername(segunda.id, USER, PASSWORD)).rejects.toThrow(/tomado/i);
    expect(segunda.username).toBe('otro.user');
  });

  /*
   * Ya no se crean cuentas sin verificar —el registro entra de una—, pero
   * quedaron las de antes: alguien que empezó el registro y nunca metió el
   * código. Esas siguen sin poder entrar con la contraseña que dejaron a
   * medias.
   */
  it('una cuenta vieja a medio registrar sigue sin poder entrar', async () => {
    const ctx = build();
    await registered(ctx);
    ctx.users.users[0].verified = false;

    await expect(ctx.service.login(USER, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
