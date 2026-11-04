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
  async contar() {
    return this.users.length;
  }
  async listar() {
    return [...this.users];
  }
  async eliminar(id: string) {
    const i = this.users.findIndex((u) => u.id === id);
    if (i < 0) return false;
    this.users.splice(i, 1);
    return true;
  }
}

/** Invitaciones de mentira: lleva la cuenta de qué códigos se canjearon. */
class InvitacionesFalsas {
  validos = new Set<string>();
  canjeados: string[] = [];
  async canjear(codigo: string, usuarioId: string) {
    if (!this.validos.has(codigo)) throw new Error('El código de invitación no es válido o ya venció.');
    this.validos.delete(codigo);
    this.canjeados.push(`${codigo}:${usuarioId}`);
    return 'inv-1';
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
  const invitaciones = new InvitacionesFalsas();
  const service = new AuthService(
    users,
    invitaciones as never,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    otp as unknown as OtpSender,
    config as never,
  );
  return { service, users, otp, invitaciones };
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
    ctx.invitaciones.validos.add('CODE');

    await expect(ctx.service.register(USER, 'otraClave123', PHONE, undefined, 'CODE')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Y la contraseña del dueño real no se toca.
    expect(ctx.users.users[0].passwordHash).toBe(hashOriginal);
  });

  it('la PRIMERA cuenta se crea sin invitación; la segunda ya no', async () => {
    /*
     * Esto es el agujero que estuvo abierto en producción: `register` era
     * público y entregaba sesión al instante, así que cualquiera con la URL
     * se creaba una cuenta y leía los datos de los ciudadanos. Se comprobó
     * contra el dominio real antes de cerrarlo.
     *
     * La puerta de arranque se cierra SOLA en cuanto existe una cuenta: no
     * es una bandera de configuración que alguien pueda dejar encendida.
     */
    const ctx = build();
    await ctx.service.register(USER, PASSWORD, PHONE);
    expect(ctx.users.users).toHaveLength(1);

    await expect(
      ctx.service.register('colado', PASSWORD, '+50455556666'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.users.users).toHaveLength(1);
  });

  it('con invitación válida sí entra, y el código se canjea una sola vez', async () => {
    const ctx = build();
    await registered(ctx);
    ctx.invitaciones.validos.add('BUENA');

    await ctx.service.register('invitado', PASSWORD, '+50477778888', undefined, 'BUENA');
    expect(ctx.users.users).toHaveLength(2);
    expect(ctx.invitaciones.canjeados).toHaveLength(1);

    // El mismo código no sirve dos veces.
    await expect(
      ctx.service.register('otro.mas', PASSWORD, '+50499998888', undefined, 'BUENA'),
    ).rejects.toThrow(/no es válido o ya venció/i);
  });

  it('un código inventado no abre la puerta', async () => {
    const ctx = build();
    await registered(ctx);

    await expect(
      ctx.service.register('colado', PASSWORD, '+50433334444', undefined, 'INVENTADO'),
    ).rejects.toThrow(/no es válido/i);
    expect(ctx.users.users).toHaveLength(1);
  });

  it('nadie borra su propia cuenta ni la última que queda', async () => {
    // Las dos dejarían la consola sin nadie que pueda entrar ni invitar.
    const ctx = build();
    await registered(ctx);
    const yo = ctx.users.users[0];

    await expect(ctx.service.eliminarCuenta(yo.id, yo.id)).rejects.toThrow(/tu propia cuenta/i);

    ctx.invitaciones.validos.add('C2');
    await ctx.service.register('otro', PASSWORD, '+50466667777', undefined, 'C2');
    const otro = ctx.users.users[1];
    await ctx.service.eliminarCuenta(otro.id, yo.id);

    await expect(ctx.service.eliminarCuenta(yo.id, 'alguien')).rejects.toThrow(/única cuenta/i);
  });

  it('el equipo se lista sin hashes y con el teléfono enmascarado', async () => {
    const ctx = build();
    await registered(ctx);

    const equipo = await ctx.service.equipo();
    expect(equipo[0].phone).not.toBe(PHONE);
    expect(JSON.stringify(equipo)).not.toContain('passwordHash');
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

    // Segunda cuenta, con otro teléfono y su invitación.
    ctx.invitaciones.validos.add('CODE');
    await ctx.service.register('otro.user', PASSWORD, '+50411112222', undefined, 'CODE');
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
