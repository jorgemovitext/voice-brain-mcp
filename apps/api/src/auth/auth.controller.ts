import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { InvitacionesService } from './invitaciones.service';
import { SESSION_COOKIE } from './auth.guard';
import { DESCRIPCION_ROL, matriz, NOMBRE_ROL, ROLES } from './permisos';
import { Requiere } from './permisos.guard';
import { Public } from './public.decorator';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * Endpoints de autenticación. Los cuatro públicos (register/login/resend-otp/
 * verify-otp) llevan además un freno por IP (RateLimitGuard); el resto de la
 * API queda detrás del AuthGuard global.
 *
 * La sesión viaja en cookie httpOnly + Secure + SameSite=Lax: el JS del
 * navegador nunca ve el token (anti-XSS) y no se envía en requests
 * cross-site (anti-CSRF para POSTs de terceros).
 */

/**
 * Código de país que se asume cuando alguien escribe solo su número local.
 * Honduras por defecto; se cambia con una variable de entorno.
 */
const CODIGO_PAIS = process.env.AUTH_CODIGO_PAIS ?? '504';

/**
 * El teléfono, escrito como lo escribe la gente.
 *
 * Se guarda en E.164 con «+», pero exigirlo en el formulario era rechazar
 * «9761-6546» y «504 9761 6546», que es como se dicta un número acá. El que
 * se registraba lo acomodaba; el que no, se iba.
 */
const phoneSchema = z
  .string()
  .transform((s) => {
    const digitos = s.replace(/\D/g, '');
    if (!digitos) return s.trim();
    // Solo el número local: le falta el país y se le pone el de casa.
    if (!s.trim().startsWith('+') && digitos.length <= 8) return `+${CODIGO_PAIS}${digitos}`;
    return `+${digitos}`;
  })
  .pipe(
    z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'Ese teléfono no parece válido. Probá así: 9761-6546 o +504 9761-6546'),
  );

/** Usuario: 3–32 caracteres, letras/números/._- Se normaliza a minúsculas. */
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(3, 'El usuario debe tener al menos 3 caracteres')
      .max(32, 'El usuario no puede pasar de 32 caracteres')
      .regex(/^[a-z0-9._-]+$/, 'El usuario solo admite letras, números y . _ -'),
  );

/**
 * Para iniciar sesión se acepta el usuario o el teléfono de las cuentas
 * creadas antes de que el acceso fuera por usuario. Se quitan espacios y
 * guiones para que un número tecleado como "+504 9999-8888" resuelva igual
 * que en E.164; un usuario válido nunca los lleva.
 */
const identificadorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().min(3, 'Indicá tu usuario o teléfono').max(32));

/** Mínimo 8, al menos una letra y un número. */
const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .regex(/[a-zA-Z]/, 'La contraseña debe incluir letras')
  .regex(/\d/, 'La contraseña debe incluir números');

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  /** Solo para recibir el código: no es el identificador de acceso. */
  phone: phoneSchema,
  name: z.string().trim().min(2).max(80).optional(),
  /** Con código se entra a una empresa existente; sin código se crea una. */
  invitacion: z.string().trim().max(40).optional(),
  /** El nombre de la empresa, cuando el alta la crea. */
  empresa: z.string().trim().max(120).optional(),
});
const loginSchema = z.object({ username: identificadorSchema, password: z.string().min(1).max(200) });
const otpSchema = z.object({
  username: identificadorSchema,
  code: z.string().regex(/^\d{6}$/, 'El código son 6 dígitos'),
});
const resendSchema = z.object({ username: identificadorSchema });
const setUsernameSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200) });
/** Solo los dos roles que existen: un valor libre acá sería un rol inventado. */
const rolSchema = z.object({ rol: z.enum(['admin', 'usuario']) });

@Controller('api/auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly invitaciones: InvitacionesService,
    config: ConfigService,
  ) {
    // Secure solo aplica sobre HTTPS; en dev local (http) rompería la cookie.
    this.secureCookies = config.get<boolean>('SERVERLESS', false);
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    return parsed.data;
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { username, password, phone, name, invitacion, empresa } = this.parse(registerSchema, body);
    const { token, user } = await this.auth.register(username, password, phone, name, invitacion, empresa);
    this.abrirSesion(res, token);
    return { user };
  }

  /* --- Equipo e invitaciones (con sesión) --- */

  @Post('invitaciones')
  async invitar(
    @Body() body: { phone?: string; nota?: string },
    @Req() req: FastifyRequest & { user?: { sub: string; username?: string; org?: string } },
  ) {
    return this.invitaciones.crear({
      phone: body?.phone?.trim() || undefined,
      nota: body?.nota?.trim() || undefined,
      creadaPor: req.user?.username ?? req.user?.sub ?? 'desconocido',
      // Del TOKEN y no del cuerpo: una organización que el cliente puede
      // elegir es una invitación para entrar a la empresa de otro.
      organizacion: req.user?.org ?? '',
    });
  }

  @Get('invitaciones')
  listarInvitaciones(@Req() req: FastifyRequest & { user?: { org?: string } }) {
    return this.invitaciones.listar(req.user?.org);
  }

  @Delete('invitaciones/:id')
  async revocar(@Param('id') id: string, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    await this.invitaciones.revocar(id, req.user?.org ?? '');
    return { ok: true };
  }

  @Get('equipo')
  equipo(@Req() req: FastifyRequest & { user?: { org?: string } }) {
    return this.auth.equipo(req.user?.org);
  }

  @Requiere('equipo:editar')
  @Delete('equipo/:id')
  async quitarDelEquipo(
    @Param('id') id: string,
    @Req() req: FastifyRequest & { user?: { sub: string } },
  ) {
    await this.auth.eliminarCuenta(id, req.user?.sub ?? '');
    return { ok: true };
  }

  /**
   * Sube o baja a alguien del equipo. Solo hay dos roles: administrador y
   * usuario (ver `permisos.ts`).
   */
  @Requiere('equipo:editar')
  @Patch('equipo/:id/rol')
  async cambiarRol(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { user?: { sub: string; org?: string } },
  ) {
    const { rol } = this.parse(rolSchema, body);
    // La organización sale del TOKEN: con el id en la URL y la empresa en el
    // cuerpo, un administrador podría ascender a alguien en la cuenta de otro
    // cliente.
    await this.auth.cambiarRol(id, rol, req.user?.sub ?? '', req.user?.org);
    return { ok: true };
  }

  /** La matriz de permisos, para que la pantalla de equipo la explique. */
  @Get('permisos')
  permisos() {
    return { roles: ROLES.map((r) => ({ id: r, nombre: NOMBRE_ROL[r], descripcion: DESCRIPCION_ROL[r] })), matriz: matriz() };
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { username, password } = this.parse(loginSchema, body);
    const { token, user, otpRequired } = await this.auth.login(username, password);
    this.abrirSesion(res, token);
    return { otpRequired, user };
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('resend-otp')
  resend(@Body() body: unknown) {
    const { username } = this.parse(resendSchema, body);
    return this.auth.resendOtp(username);
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('verify-otp')
  async verifyOtp(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { username, code } = this.parse(otpSchema, body);
    const { token, user } = await this.auth.verifyOtp(username, code);
    this.abrirSesion(res, token);
    return { user };
  }

  /** La cookie de sesión: httpOnly, así que el JS de la consola nunca la ve. */
  private abrirSesion(res: FastifyReply, token: string): void {
    res.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: this.auth.sessionHours * 3600,
    });
  }

  /**
   * Fija el usuario de acceso de la cuenta con sesión. Protegido por el guard
   * global y, además, por la contraseña actual (ver AuthService.setUsername).
   */
  @Requiere('cuenta-propia')
  @Post('username')
  setUsername(@Body() body: unknown, @Req() req: FastifyRequest & { user?: { sub: string } }) {
    const { username, password } = this.parse(setUsernameSchema, body);
    return this.auth.setUsername(req.user?.sub ?? '', username, password);
  }

  /** Protegido por el guard global: sirve para validar la sesión al cargar la consola. */
  @Get('me')
  me(@Req() req: FastifyRequest & { user?: { sub: string } }) {
    return this.auth.me(req.user?.sub ?? '');
  }

  /** Cierra la sesión en TODOS los dispositivos, no solo en este navegador. */
  @Requiere('cuenta-propia')
  @Post('cerrar-todo')
  async cerrarTodo(
    @Req() req: FastifyRequest & { user?: { sub: string } },
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.auth.cerrarSesiones(req.user?.sub ?? '');
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Requiere('cuenta-propia')
  @Post('logout')
  logout(@Res({ passthrough: true }) res: FastifyReply) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
