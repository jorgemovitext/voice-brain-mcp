import { BadRequestException, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './auth.guard';
import { Public } from './public.decorator';

/**
 * Endpoints de autenticación. Los tres primeros son públicos por necesidad;
 * el resto de la API queda detrás del AuthGuard global.
 *
 * La sesión viaja en cookie httpOnly + Secure + SameSite=Lax: el JS del
 * navegador nunca ve el token (anti-XSS) y no se envía en requests
 * cross-site (anti-CSRF para POSTs de terceros).
 */

/** E.164: +50499998888 (8 a 15 dígitos, sin espacios). */
const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Teléfono inválido: usá formato E.164, ej. +50499998888'));

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
});
const loginSchema = z.object({ username: identificadorSchema, password: z.string().min(1).max(200) });
const otpSchema = z.object({
  username: identificadorSchema,
  code: z.string().regex(/^\d{6}$/, 'El código son 6 dígitos'),
});
const resendSchema = z.object({ username: identificadorSchema });
const setUsernameSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200) });

@Controller('api/auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
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
  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { username, password, phone, name } = this.parse(registerSchema, body);
    const { token, user } = await this.auth.register(username, password, phone, name);
    this.abrirSesion(res, token);
    return { user };
  }

  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { username, password } = this.parse(loginSchema, body);
    const { token, user, otpRequired } = await this.auth.login(username, password);
    this.abrirSesion(res, token);
    return { otpRequired, user };
  }

  @Public()
  @Post('resend-otp')
  resend(@Body() body: unknown) {
    const { username } = this.parse(resendSchema, body);
    return this.auth.resendOtp(username);
  }

  @Public()
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

  @Post('logout')
  logout(@Res({ passthrough: true }) res: FastifyReply) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
