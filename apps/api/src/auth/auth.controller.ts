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

/** Mínimo 8, al menos una letra y un número. */
const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .regex(/[a-zA-Z]/, 'La contraseña debe incluir letras')
  .regex(/\d/, 'La contraseña debe incluir números');

const registerSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
  name: z.string().trim().min(2).max(80).optional(),
});
const loginSchema = z.object({ phone: phoneSchema, password: z.string().min(1).max(200) });
const otpSchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, 'El código son 6 dígitos') });
const resendSchema = z.object({ phone: phoneSchema });

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
  register(@Body() body: unknown) {
    const { phone, password, name } = this.parse(registerSchema, body);
    return this.auth.register(phone, password, name);
  }

  @Public()
  @Post('login')
  login(@Body() body: unknown) {
    const { phone, password } = this.parse(loginSchema, body);
    return this.auth.login(phone, password);
  }

  @Public()
  @Post('resend-otp')
  resend(@Body() body: unknown) {
    const { phone } = this.parse(resendSchema, body);
    return this.auth.resendOtp(phone);
  }

  @Public()
  @Post('verify-otp')
  async verifyOtp(@Body() body: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const { phone, code } = this.parse(otpSchema, body);
    const { token, user } = await this.auth.verifyOtp(phone, code);

    res.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: this.auth.sessionHours * 3600,
    });
    return { user };
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
