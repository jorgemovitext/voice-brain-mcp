import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { InvitacionesService } from './invitaciones.service';
import { OrganizacionesService } from './organizaciones.service';
import { Permiso, permisosDe, Rol, rolValido } from './permisos';
import { OtpSender } from './otp.sender';
import { AuthUser, soloDigitos, USERS_REPOSITORY, UsersRepository } from './users.repository';

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
  username?: string;
  phone: string;
  name?: string;
  /**
   * Qué puede hacer, resuelto en el servidor.
   *
   * Va junto con la sesión y no se calcula en la consola: la pantalla tiene
   * que poder esconder lo que no corresponde sin reimplementar la matriz de
   * permisos, y una regla que vive en dos lados se desincroniza en la
   * primera semana. Esconder NO es proteger —eso lo hace el guard—, pero
   * mostrar un botón que va a devolver 403 es una trampa para el usuario.
   */
  rol?: Rol;
  permisos?: Permiso[];
  /** La empresa a la que pertenece y en qué plan está. */
  organizacion?: string;
  empresa?: string;
  plan?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly otpTtlMin: number;
  /** Código de país que se asume cuando alguien escribe solo su número local. */
  private readonly codigoPais: string;
  readonly sessionHours: number;

  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    private readonly invitaciones: InvitacionesService,
    private readonly organizaciones: OrganizacionesService,
    private readonly jwt: JwtService,
    private readonly otpSender: OtpSender,
    config: ConfigService,
  ) {
    this.otpTtlMin = config.get<number>('AUTH_OTP_TTL_MIN', 5);
    // Honduras. Es de dónde son los clientes, y se cambia con una variable.
    this.codigoPais = config.get<string>('AUTH_CODIGO_PAIS', '504');
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
   * Alta de usuario: se identifica con `username`; el teléfono solo sirve para
   * recibir el código. La respuesta es SIEMPRE la misma existan o no el
   * usuario y el número (anti-enumeración): si están libres o pendientes de
   * verificar se crea/actualiza y se envía OTP; si ya están tomados, nada.
   */
  /**
   * Alta de una cuenta. Pública: Hive se vende a cualquiera.
   *
   * Lo que hace segura el alta abierta NO es una puerta, es el aislamiento:
   * quien se registra crea SU organización y la estrena vacía. Nunca ve un
   * contacto, una conversación ni un agente de otro. Sin eso, registrarse
   * sería leer los datos de los ciudadanos de otro cliente — el agujero que
   * ya estuvo abierto una vez y que esto cierra de raíz en vez de con un
   * código de invitación.
   *
   * Con `invitacion`, en cambio, NO se crea organización: la persona entra a
   * la de quien la invitó. Es el camino para sumar un colega, que es lo que
   * una invitación significa en cualquier SaaS.
   */
  async register(
    username: string,
    password: string,
    phone: string,
    name?: string,
    invitacion?: string,
    empresa?: string,
  ): Promise<{ token: string; user: SessionUser }> {
    const porUsuario = await this.users.findByUsername(username);
    const porTelefono = await this.users.findByPhone(phone);

    const tomado = porUsuario?.verified || (porTelefono?.verified && porTelefono.id !== porUsuario?.id);
    if (tomado) {
      this.logger.warn(`Registro sobre usuario/teléfono ya verificado: ${username}`);
      throw new ConflictException('Ese usuario o ese teléfono ya están registrados.');
    }

    const existing = porUsuario ?? porTelefono;
    const user: AuthUser = existing ?? {
      id: randomUUID(),
      username,
      phone,
      passwordHash: '',
      verified: false,
      failedLogins: 0,
      otpAttempts: 0,
      createdAt: new Date().toISOString(),
    };
    user.username = username;
    user.phone = phone;
    user.name = name ?? user.name;
    user.passwordHash = await this.hashPassword(password);
    /*
     * Se entra de una. El número queda sin comprobar —el OTP era lo que lo
     * comprobaba— y el mensaje neutro de antes ya no aplica: al responder
     * "ya está registrado" se admite que ese usuario existe.
     *
     * Es la contra de que crear la cuenta sea un paso y no tres, y para una
     * consola interna con altas contadas es un cambio aceptable. Si algún día
     * el registro se abre a cualquiera, esto se revierte.
     */
    /*
     * `verified` en true sin OTP: el OTP viaja por WhatsApp y WhatsApp solo
     * entrega texto libre dentro de la ventana de 24 h. Exigirlo para entrar
     * deja a alguien afuera por una regla de Meta —ya pasó— y para un alta
     * pública sería perder a la mitad de los que prueban el producto. Queda
     * para recuperar el acceso, donde su demora no bloquea a nadie.
     */
    user.verified = true;
    user.failedLogins = 0;

    /*
     * Con código entra a la organización de quien invitó; sin código, crea
     * la suya. El canje va ANTES de guardar: al revés, un código inválido
     * devolvía error pero dejaba la cuenta creada y lista para entrar por el
     * login — o sea, no filtraba nada. Lo encontró un test, no la lectura.
     */
    if (invitacion?.trim()) {
      const destino = await this.invitaciones.canjear(invitacion.trim(), user.id);
      user.organizacionId = destino.organizacion;
      // Quien llega con código entra como usuario: el que invita decide
      // después si le sube el rol. Nadie se autoasciende al registrarse.
      user.rol = 'usuario';
    } else {
      user.organizacionId = await this.organizaciones.crear(
        empresa?.trim() || name?.trim() || username,
      );
      // El que estrena la empresa es su administrador. Si no, la cuenta
      // nacería sin nadie que pueda invitar ni configurar: muerta.
      user.rol = 'admin';
      this.logger.log(`Alta nueva: ${username} estrena la organización ${user.organizacionId}`);
    }

    await this.users.save(user);

    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      phone: user.phone,
      name: user.name,
    };
    const token = await this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      org: user.organizacionId,
      rol: user.rol ?? 'usuario',
    });
    return { token, user: sessionUser };
  }

  /** Sin ninguna cuenta todavía: la primera se crea sin invitación. */
  async esArranque(): Promise<boolean> {
    return (await this.users.contar()) === 0;
  }

  /**
   * Cierra TODAS las sesiones de una cuenta, ya.
   *
   * Es la revocación: adelanta la marca y cualquier token emitido antes deja
   * de valer. Se usa al cambiar la contraseña —si alguien te la robó, su
   * sesión tiene que morir con el cambio— y está disponible para cuando un
   * operador pierda el teléfono.
   */
  async cerrarSesiones(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) return;
    user.tokensDesde = new Date().toISOString();
    await this.users.save(user);
    this.logger.warn(`Sesiones cerradas para ${user.username ?? userId}`);
  }

  /** El equipo con acceso a la consola. Nunca sale un hash de acá. */
  async equipo(
    org?: string,
  ): Promise<Array<{ id: string; username?: string; name?: string; phone: string; rol: Rol; creada: string }>> {
    const todos = await this.users.listar(org);
    return todos.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      rol: rolValido(u.rol),
      // Enmascarado: el equipo se reconoce por el nombre, no por el número
      // completo de alguien más.
      phone: u.phone.replace(/^(\+\d{3})\d+(\d{4})$/, '$1••••$2'),
      creada: u.createdAt,
    }));
  }

  /**
   * Da de baja una cuenta.
   *
   * Dos frenos: nadie se borra a sí mismo —quedaría una sesión viva sin
   * cuenta detrás— y no se puede borrar la última, que dejaría la consola
   * sin nadie que pueda entrar ni invitar.
   */
  async eliminarCuenta(id: string, quienPide: string, org?: string): Promise<void> {
    if (id === quienPide) {
      throw new ConflictException(
        'No podés borrar a otro con tu propia cuenta desde acá: usá «Dar de baja mi cuenta».',
      );
    }
    const victima = await this.users.findById(id);
    /*
     * Solo gente de la MISMA empresa. El id viaja en la URL y es
     * adivinable: sin esto, el administrador de cualquier cliente podía
     * borrarle cuentas a otro. «No existe» y no «no es tuya», para que la
     * respuesta tampoco confirme que ese id existe.
     */
    if (!victima || (org && victima.organizacionId !== org)) {
      throw new ConflictException('Esa cuenta ya no existe.');
    }

    /*
     * La cuenta se cuenta DENTRO de su empresa, no en toda la plataforma.
     * Con el total global, un cliente con un solo usuario podía borrarlo y
     * dejar su empresa sin nadie —inalcanzable para siempre— porque en la
     * plataforma había cientos de cuentas más.
     */
    if (victima.organizacionId && (await this.users.contarEn(victima.organizacionId)) <= 1) {
      throw new ConflictException('Es la única cuenta de la empresa: borrarla la dejaría sin acceso.');
    }

    const ok = await this.users.eliminar(id);
    if (!ok) throw new ConflictException('Esa cuenta ya no existe.');
    this.logger.warn(`Cuenta eliminada: ${id} (por ${quienPide})`);
  }

  /**
   * Dar de baja la cuenta propia.
   *
   * Faltaba, y la falta se nota cuando alguien prueba el producto: una
   * cuenta que estrena su propia empresa no la puede borrar NADIE. No es
   * suya de otro administrador —está sola en su empresa— y ella misma
   * tenía prohibido borrarse. Quedaban para siempre, con su empresa vacía
   * detrás.
   *
   * Pide la contraseña aunque haya sesión: es destructivo y no se deshace,
   * y una sesión abierta en una máquina prestada no debería alcanzar.
   *
   * Si al irse la empresa queda sin nadie, se borra también. Una empresa
   * sin usuarios no se puede alcanzar desde ninguna pantalla: son filas
   * que se acumulan sin que nadie pueda limpiarlas.
   */
  async darDeBajaMiCuenta(userId: string, password: string): Promise<{ empresaBorrada: boolean }> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Sesión inválida');

    if (!(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('La contraseña no coincide.');
    }

    const org = user.organizacionId;
    /*
     * Si quedan compañeros, tiene que quedar alguien que pueda configurar.
     * Irse siendo el único administrador deja la empresa con gente adentro
     * y sin nadie que pueda invitar, cambiar el plan ni tocar un agente.
     */
    if (org) {
      const equipo = await this.users.listar(org);
      const otrosAdmins = equipo.filter((u) => u.id !== userId && rolValido(u.rol) === 'admin');
      if (equipo.length > 1 && !otrosAdmins.length) {
        throw new ConflictException(
          'Sos el único administrador y queda gente en la empresa: pasale el rol a alguien antes de irte.',
        );
      }
    }

    await this.users.eliminar(userId);
    this.logger.warn(`Cuenta dada de baja por su dueño: ${user.username ?? userId}`);

    let empresaBorrada = false;
    if (org && (await this.users.contarEn(org)) === 0) {
      empresaBorrada = await this.organizaciones.eliminar(org).catch(() => false);
    }
    return { empresaBorrada };
  }

  /**
   * Resuelve la cuenta por nombre de usuario. Como respaldo acepta el teléfono
   * en E.164, para no dejar afuera a las cuentas creadas antes de que el login
   * fuera por usuario.
   */
  /**
   * La cuenta de quien dice ser `identificador`: su usuario o su teléfono.
   *
   * Antes el teléfono solo se reconocía en E.164 estricto, con «+» y código
   * de país. O sea que quien se registró con su número y al volver escribía
   * «97616546» —como lo sabe de memoria— recibía «credenciales inválidas»:
   * el mensaje le echaba la culpa a la contraseña y la cuenta quedaba
   * inalcanzable para su propio dueño.
   *
   * Ahora se prueba por dígitos, y si vienen solo los locales se les
   * antepone el código del país de la cuenta. No es adivinar: es que un
   * número sin código de país, en un producto que se vende en Honduras, es
   * un número hondureño.
   */
  private async buscarCuenta(identificador: string): Promise<AuthUser | undefined> {
    const porUsuario = await this.users.findByUsername(identificador);
    if (porUsuario) return porUsuario;

    const digitos = soloDigitos(identificador);
    // Un usuario puede llevar números; lo que NO lleva es solo números.
    if (!digitos || digitos.length !== identificador.replace(/^\+/, '').length) return undefined;

    const porTelefono = await this.users.findByPhone(digitos);
    if (porTelefono) return porTelefono;

    // Sin código de país: se prueba con el de casa.
    return digitos.length <= 8 ? this.users.findByPhone(`${this.codigoPais}${digitos}`) : undefined;
  }

  // =============== Login (password + OTP como segundo factor) ===============

  async login(
    usuario: string,
    password: string,
  ): Promise<{ otpRequired: false; token: string; user: SessionUser }> {
    const user = await this.buscarCuenta(usuario);

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
        this.logger.warn(`Cuenta bloqueada ${LOCK_MINUTES} min por intentos fallidos: ${usuario}`);
      }
      await this.users.save(user);
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    user.failedLogins = 0;
    user.lockedUntil = undefined;
    await this.users.save(user);

    /*
     * Sin segundo factor: la cuenta ya verificó su número al registrarse, y
     * pedir un OTP por WhatsApp en CADA entrada dejaba al operador fuera de la
     * consola cada vez que expiraba la sesión — con una emergencia abierta,
     * eso es peor que el riesgo que cubría.
     *
     * El OTP sigue vivo donde sí hace falta: verificar el número al registrar
     * (`verifyOtp` marca `verified`) y recuperar el acceso.
     */
    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      phone: user.phone,
      name: user.name,
    };
    const token = await this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      org: user.organizacionId,
      rol: user.rol ?? 'usuario',
    });
    return { otpRequired: false, token, user: sessionUser };
  }

  // =============== OTP ===============

  private hashOtp(code: string, userId: string): string {
    // Ligado al userId para que un hash filtrado no sirva contra otra cuenta.
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }

  /**
   * Genera, guarda (solo hash) y envía el código.
   *
   * `forzar` salta el cooldown: lo usa el login, donde la contraseña ya se
   * validó y dejar al usuario esperando un código que nunca salió sería un
   * callejón sin salida. El cooldown sigue protegiendo los caminos que no
   * exigen contraseña (registro y reenvío) contra el spam a un número.
   */
  private async issueOtp(user: AuthUser, forzar = false): Promise<void> {
    const enCooldown =
      user.otpLastSentAt && Date.now() - new Date(user.otpLastSentAt).getTime() < OTP_RESEND_COOLDOWN_S * 1000;
    if (enCooldown && !forzar) {
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
  async resendOtp(usuario: string): Promise<{ message: string }> {
    const user = await this.buscarCuenta(usuario);
    if (user) await this.issueOtp(user);
    return { message: 'Si la cuenta existe, te reenviamos un código.' };
  }

  /**
   * Verifica el OTP y, si es válido, devuelve el JWT de sesión.
   * El código expira, admite 5 intentos y es de un solo uso.
   */
  async verifyOtp(usuario: string, code: string): Promise<{ token: string; user: SessionUser }> {
    const user = await this.buscarCuenta(usuario);
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

    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      phone: user.phone,
      name: user.name,
    };
    /*
     * El token lleva la empresa y el rol, igual que el del login.
     *
     * Salía sin las dos: quien entraba por este camino —el de recuperar el
     * acceso— quedaba con sesión válida y SIN organización. La consola le
     * mostraba todo vacío, que es peor que no dejarlo entrar, porque parece
     * que se le borraron los datos.
     */
    const token = await this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      org: user.organizacionId,
      rol: user.rol ?? 'usuario',
    });
    return { token, user: sessionUser };
  }

  private async clearOtp(user: AuthUser): Promise<void> {
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    user.otpAttempts = 0;
    await this.users.save(user);
  }

  // =============== Perfil ===============

  /**
   * Fija o cambia el usuario de acceso. Exige la contraseña actual aunque ya
   * haya sesión: el usuario es el identificador con el que se entra, y
   * cambiarlo con una cookie robada dejaría afuera al dueño real. Acá SÍ se
   * dice si el nombre está tomado — quien pide necesita saber que elija otro,
   * y ya está autenticado, así que no hay enumeración que proteger.
   */
  async setUsername(userId: string, username: string, password: string): Promise<SessionUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Sesión inválida');

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      throw new UnauthorizedException(GENERIC_FAIL);
    }

    const ok = await this.verifyPassword(password, user.passwordHash);
    if (!ok) {
      user.failedLogins += 1;
      if (user.failedLogins >= MAX_LOGIN_FAILS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
        user.failedLogins = 0;
      }
      await this.users.save(user);
      throw new UnauthorizedException('La contraseña no coincide.');
    }

    const dueno = await this.users.findByUsername(username);
    if (dueno && dueno.id !== user.id) {
      throw new ConflictException('Ese usuario ya está tomado. Probá con otro.');
    }

    user.username = username;
    user.failedLogins = 0;
    await this.users.save(user);
    this.logger.log(`Usuario de acceso asignado a la cuenta ${user.id}`);
    return { id: user.id, username: user.username, phone: user.phone, name: user.name };
  }

  // =============== Sesión ===============

  async me(userId: string): Promise<SessionUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Sesión inválida');

    /*
     * La empresa y el plan se leen acá y no se guardan en el token: el plan
     * cambia en medio de una sesión —alguien pasa a Institucional— y un
     * token firmado con el plan viejo dejaría la cuenta pagando por
     * funciones que la consola le sigue escondiendo hasta que vuelva a
     * entrar.
     */
    const empresa = user.organizacionId
      ? await this.organizaciones.leer(user.organizacionId).catch(() => null)
      : null;

    const rol = rolValido(user.rol);
    return {
      id: user.id,
      username: user.username,
      phone: user.phone,
      name: user.name,
      rol,
      permisos: permisosDe(rol),
      organizacion: user.organizacionId,
      empresa: empresa?.nombre,
      plan: empresa?.plan ?? 'prueba',
    };
  }

  /**
   * Cambia el rol de alguien del equipo.
   *
   * Dos frenos, y los dos existen por el mismo motivo —que la cuenta no
   * quede sin nadie que pueda configurarla:
   *
   *  - Nadie se baja a sí mismo de administrador. Si fuera el único, la
   *    empresa quedaría sin quien invite, cambie el plan o toque un agente,
   *    y la única salida sería que nosotros editemos la base a mano.
   *  - Solo se toca a gente de la MISMA empresa. El id viaja en la URL y es
   *    adivinable: sin esta comprobación, un administrador podría ascenderse
   *    un cómplice en la cuenta de otro cliente.
   */
  async cambiarRol(id: string, rol: Rol, quienPide: string, org?: string): Promise<void> {
    if (id === quienPide) {
      throw new ConflictException('No podés cambiar tu propio rol: pedíselo a otro administrador.');
    }
    const user = await this.users.findById(id);
    if (!user || (org && user.organizacionId !== org)) {
      throw new NotFoundException('Esa cuenta no es de tu empresa.');
    }
    user.rol = rolValido(rol);
    await this.users.save(user);

    /*
     * El rol viaja dentro del token, así que bajarlo no surte efecto hasta
     * que la sesión se renueve: alguien a quien le quitan el rol de
     * administrador seguiría configurando por horas con el token que ya
     * tiene. Se le cierran las sesiones y vuelve a entrar con el rol nuevo.
     */
    await this.cerrarSesiones(id);
    this.logger.log(`Rol de ${user.username ?? id}: ${user.rol}`);
  }

  /** Hash fijo para igualar tiempos cuando el usuario no existe. */
  private dummyPromise: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    this.dummyPromise ??= this.hashPassword(randomBytes(12).toString('hex'));
    return this.dummyPromise;
  }
}
