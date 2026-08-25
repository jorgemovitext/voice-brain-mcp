import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Nombre de la cookie de sesión (httpOnly: el JS del navegador no la ve). */
export const SESSION_COOKIE = 'vb_session';

/**
 * Guard GLOBAL (APP_GUARD): toda ruta exige sesión salvo que esté marcada
 * @Public(). Deny-by-default: un controller nuevo nace protegido; olvidarse
 * del decorador cierra de más, nunca de menos.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly sessionHours: number;
  private readonly secureCookies: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.sessionHours = config.get<number>('AUTH_SESSION_HOURS', 12);
    this.secureCookies = config.get<string>('NODE_ENV') === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Sesión requerida');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; username?: string; exp: number }>(token);
      req.user = payload;
      await this.renovarSiCorresponde(context, payload);
      return true;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }

  /**
   * Sesión deslizante: pasada la mitad de su vida, cada petición la renueva.
   *
   * Antes la sesión moría a las 12 h contadas desde el login, estuvieras
   * trabajando o no — y expiró con una emergencia abierta en pantalla. Así,
   * a quien está usando la consola no la echa nunca, y la de quien se fue
   * sigue caducando: el reloj corre desde la ÚLTIMA actividad, no desde la
   * primera.
   */
  private async renovarSiCorresponde(
    context: ExecutionContext,
    payload: { sub: string; username?: string; exp: number },
  ): Promise<void> {
    const restanteMs = payload.exp * 1000 - Date.now();
    if (restanteMs > (this.sessionHours * 3600_000) / 2) return;

    const res = context.switchToHttp().getResponse<FastifyReply>();
    // Bearer (herramientas/API) no usa cookie: no hay nada que renovar.
    if (typeof res?.setCookie !== 'function') return;

    const token = await this.jwt.signAsync({ sub: payload.sub, username: payload.username });
    res.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionHours * 3600,
    });
  }

  private extractToken(req: FastifyRequest): string | undefined {
    // Cookie httpOnly (la consola) o Bearer (herramientas/API).
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    if (cookies?.[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return undefined;
  }
}
