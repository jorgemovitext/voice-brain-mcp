import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
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
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

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
      req.user = await this.jwt.verifyAsync(token);
      return true;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
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
