import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { OtpSender } from './otp.sender';
import { AuthUser, soloDigitos, UsersRepository } from './users.repository';

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
    // Por dígitos, igual que el repositorio real: si el doble comparara
    // texto exacto, la prueba pasaría y producción seguiría rota.
    return this.users.find((u) => soloDigitos(u.phone) === soloDigitos(phone));
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
  async contarEn(org: string) {
    return this.users.filter((u) => u.organizacionId === org).length;
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
  /** La invitación dice a QUÉ empresa se entra. */
  organizacion = 'org-de-quien-invita';
  async canjear(codigo: string, usuarioId: string) {
    if (!this.validos.has(codigo)) throw new Error('El código de invitación no es válido o ya venció.');
    this.validos.delete(codigo);
    this.canjeados.push(`${codigo}:${usuarioId}`);
    return { id: 'inv-1', organizacion: this.organizacion };
  }
}

/** Cada alta sin código estrena su propia empresa. */
class OrganizacionesFalsas {
  creadas: string[] = [];
  borradas: string[] = [];
  /** El tipo de cada empresa creada. Por defecto, cliente. */
  tipo: 'cliente' | 'proveedor' = 'cliente';
  async leer(id: string) {
    return { id, codigo: 'C0001', nombre: 'Empresa', plan: 'prueba', tipo: this.tipo, creada: '' };
  }
  async eliminar(id: string) {
    this.borradas.push(id);
    return true;
  }
  async crear(nombre: string) {
    const id = `org-${this.creadas.length + 1}`;
    this.creadas.push(nombre);
    return id;
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
  const organizaciones = new OrganizacionesFalsas();
  const service = new AuthService(
    users,
    invitaciones as never,
    organizaciones as never,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    otp as unknown as OtpSender,
    config as never,
  );
  return { service, users, otp, invitaciones, organizaciones };
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

  it('el alta es pública y cada quien ESTRENA su propia empresa', async () => {
    /*
     * Hive se vende a cualquiera, así que registrarse no pide permiso. Lo
     * que hace segura el alta abierta no es una puerta sino el aislamiento:
     * dos cuentas creadas por separado caen en organizaciones distintas y
     * ninguna ve lo de la otra.
     *
     * Esto es lo que reemplaza al código de invitación como control. Si
     * algún día dos altas independientes compartieran organización, sería
     * la misma fuga que ya estuvo abierta una vez.
     */
    const ctx = build();
    await ctx.service.register(USER, PASSWORD, PHONE, 'Jorge', undefined, 'Clínica San Jorge');
    await ctx.service.register('otra', PASSWORD, '+50455556666', 'Ana', undefined, 'Taller Ana');

    expect(ctx.users.users).toHaveLength(2);
    const [a, b] = ctx.users.users;
    expect(a.organizacionId).toBeTruthy();
    expect(b.organizacionId).toBeTruthy();
    expect(a.organizacionId).not.toBe(b.organizacionId);
    expect(ctx.organizaciones.creadas).toEqual(['Clínica San Jorge', 'Taller Ana']);
  });

  it('con invitación NO se crea empresa: se entra a la de quien invitó', async () => {
    // Es la diferencia entre «traje un colega» y «alguien más se dio de
    // alta»: una empresa tiene varios usuarios y todos ven lo mismo.
    const ctx = build();
    await registered(ctx);
    ctx.invitaciones.validos.add('CODE');
    ctx.invitaciones.organizacion = 'org-de-jorge';

    await ctx.service.register('colega', PASSWORD, '+50477776666', 'Colega', 'CODE');

    const colega = ctx.users.users.find((u) => u.username === 'colega')!;
    expect(colega.organizacionId).toBe('org-de-jorge');
    // Y no se creó una empresa nueva por él.
    expect(ctx.organizaciones.creadas).toHaveLength(1);
  });

  it('el código se canjea UNA sola vez', async () => {
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

  it('un código inventado no mete a nadie en una empresa ajena', async () => {
    /*
     * El alta es pública, así que el código ya no es la puerta — pero sigue
     * siendo la llave de UNA empresa. Un código inválido no puede dejar la
     * cuenta creada: antes se guardaba primero y se canjeaba después, y el
     * error devolvía 400 con la cuenta ya adentro.
     */
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

    // Quien invita suma gente a SU empresa: así es como ocurre de verdad.
    ctx.invitaciones.organizacion = yo.organizacionId!;
    ctx.invitaciones.validos.add('C2');
    await ctx.service.register('otro', PASSWORD, '+50466667777', undefined, 'C2');
    const otro = ctx.users.users[1];
    await ctx.service.eliminarCuenta(otro.id, yo.id, yo.organizacionId);

    await expect(ctx.service.eliminarCuenta(yo.id, 'alguien', yo.organizacionId)).rejects.toThrow(
      /única cuenta/i,
    );
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

  /*
   * Entrar con el propio número.
   *
   * Es el caso que dejó a alguien afuera de su propia cuenta: el número se
   * buscaba en E.164 estricto, y quien lo escribía como lo sabe recibía
   * «credenciales inválidas» — un mensaje que le echa la culpa a la
   * contraseña y manda a buscar donde no es.
   */
  describe('Entrar con el teléfono, escrito como lo escribe la gente', () => {
    const FORMAS = [
      '+50499990000',
      '50499990000',
      '+504 9999-0000',
      '504 9999 0000',
      '99990000',
      '9999-0000',
    ];

    for (const forma of FORMAS) {
      it(`entra escribiendo «${forma}»`, async () => {
        const ctx = build();
        await registered(ctx);

        const { user } = await ctx.service.login(forma.replace(/[\s-]/g, ''), PASSWORD);
        expect(user.phone).toBe(PHONE);
      });
    }

    it('con la contraseña mal NO entra, por más que el número esté bien', async () => {
      const ctx = build();
      await registered(ctx);
      await expect(ctx.service.login('99990000', 'otracosa1')).rejects.toThrow(UnauthorizedException);
    });

    it('un número que no existe sigue dando el mismo error de siempre', async () => {
      // Sin enumeración: la respuesta no puede delatar si el número existe.
      const ctx = build();
      await registered(ctx);
      await expect(ctx.service.login('98887777', PASSWORD)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Recuperar el acceso con el código', () => {
    it('la sesión del código lleva empresa y rol, como la del login', async () => {
      /*
       * Salía sin las dos. Quien entraba por acá —el camino de recuperar el
       * acceso— quedaba con sesión válida y sin organización: la consola le
       * mostraba todo vacío, que parece que se le borraron los datos.
       */
      const ctx = build();
      await registered(ctx);
      await conCodigo(ctx);

      const { token } = await ctx.service.verifyOtp(USER, ctx.otp.last);
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as {
        org?: string;
        rol?: string;
      };

      expect(payload.org).toBe('org-1');
      expect(payload.rol).toBe('admin');
    });

    it('el código también se pide escribiendo el teléfono', async () => {
      const ctx = build();
      await registered(ctx);

      await ctx.service.resendOtp('99990000');
      expect(ctx.otp.sent.at(-1)?.phone).toBe(PHONE);
    });
  });

  /*
   * Darse de baja uno mismo.
   *
   * Faltaba, y la falta se nota apenas alguien prueba el producto: una
   * cuenta que estrena su propia empresa no la puede borrar NADIE —no es
   * de otro administrador y ella misma lo tenía prohibido—, así que
   * quedaba para siempre con su empresa vacía detrás.
   */
  describe('Dar de baja la cuenta propia', () => {
    it('se va la cuenta, y con ella la empresa que queda vacía', async () => {
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];

      const r = await ctx.service.darDeBajaMiCuenta(yo.id, PASSWORD);

      expect(r.empresaBorrada).toBe(true);
      expect(ctx.users.users).toHaveLength(0);
      expect(ctx.organizaciones.borradas).toEqual([yo.organizacionId]);
    });

    it('pide la contraseña aunque haya sesión', async () => {
      // Es destructivo y no se deshace: una sesión abierta en una máquina
      // prestada no debería alcanzar.
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];

      await expect(ctx.service.darDeBajaMiCuenta(yo.id, 'otracosa1')).rejects.toThrow(UnauthorizedException);
      expect(ctx.users.users).toHaveLength(1);
    });

    it('el único administrador no se va dejando gente adentro', async () => {
      /*
       * Irse siendo el único administrador deja la empresa con gente y sin
       * nadie que pueda invitar, cambiar el plan ni tocar un agente. Desde
       * afuera eso no se distingue de una cuenta rota.
       */
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];
      ctx.users.users.push({
        ...yo,
        id: 'otro',
        username: 'companera',
        rol: 'usuario',
      });

      await expect(ctx.service.darDeBajaMiCuenta(yo.id, PASSWORD)).rejects.toThrow(ConflictException);
      expect(ctx.users.users).toHaveLength(2);
    });

    it('con otro administrador en la empresa, sí se puede ir', async () => {
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];
      ctx.users.users.push({ ...yo, id: 'otro', username: 'socia', rol: 'admin' });

      const r = await ctx.service.darDeBajaMiCuenta(yo.id, PASSWORD);

      // La empresa NO se borra: queda gente adentro.
      expect(r.empresaBorrada).toBe(false);
      expect(ctx.users.users.map((u) => u.username)).toEqual(['socia']);
    });
  });

  describe('Dar de baja a otro del equipo', () => {
    it('no se puede borrar una cuenta de OTRA empresa', async () => {
      /*
       * El id viaja en la URL y es adivinable. Sin comprobar la empresa, el
       * administrador de cualquier cliente podía borrarle cuentas a otro —y
       * del lado de la víctima eso se ve como una cuenta que desapareció
       * sola.
       */
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];
      ctx.users.users.push({ ...yo, id: 'ajeno', username: 'de-otro-cliente', organizacionId: 'org-9' });
      ctx.users.users.push({ ...yo, id: 'ajeno2', username: 'colega-del-otro', organizacionId: 'org-9' });

      await expect(ctx.service.eliminarCuenta('ajeno', yo.id, yo.organizacionId)).rejects.toThrow(
        /ya no existe/i,
      );
      expect(ctx.users.users).toHaveLength(3);
    });

    it('no se puede dejar a una empresa sin ninguna cuenta', async () => {
      /*
       * Antes se contaba el total de la plataforma: un cliente con un solo
       * usuario podía borrarlo —porque en la plataforma había cientos— y
       * dejar su empresa sin nadie que pudiera entrar.
       */
      const ctx = build();
      await registered(ctx);
      const yo = ctx.users.users[0];
      ctx.users.users.push({ ...yo, id: 'otro', username: 'de-otra-empresa', organizacionId: 'org-9' });

      await expect(ctx.service.eliminarCuenta('otro', yo.id)).rejects.toThrow(ConflictException);
    });
  });
});
