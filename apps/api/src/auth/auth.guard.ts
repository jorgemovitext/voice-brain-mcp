import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';
import { USERS_REPOSITORY, UsersRepository } from './users.repository';

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

  /**
   * Cuentas ya comprobadas, por un rato corto.
   *
   * Comprobar contra la base en CADA petición sería lo más estricto, pero la
   * consola hace varias por pantalla y cada una sumaría un viaje a Neon. Con
   * 30 segundos, una sesión revocada muere en medio minuto como mucho —
   * contra las 12 horas que vivía antes— y la navegación no se arrastra.
   *
   * El número es la decisión: más alto ahorra viajes y alarga la ventana en
   * que un echado sigue adentro; más bajo es más estricto y más lento.
   */
  private static readonly CACHE_MS = 30_000;
  private readonly comprobadas = new Map<string, { hasta: number; tokensDesde: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
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

    let payload: { sub: string; username?: string; org?: string; rol?: string; exp: number; iat: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    /*
     * La firma dice que el token es NUESTRO; no dice que la cuenta siga
     * existiendo. Un JWT no se puede revocar —vive hasta que expira—, así
     * que a alguien a quien le quitaron la cuenta le quedaban hasta 12 horas
     * de acceso con el token que ya tenía en el navegador. Acá se cierra.
     */
    if (!(await this.sigueValiendo(payload.sub, payload.iat))) {
      throw new UnauthorizedException('Sesión cerrada: volvé a entrar');
    }

    req.user = payload;
    await this.renovarSiCorresponde(context, payload);
    return true;
  }

  /**
   * ¿La cuenta sigue existiendo y este token sigue siendo suyo?
   *
   * Si el repositorio falla se deja pasar: una base caída no puede echar a
   * todo el mundo de la consola. El token ya demostró estar firmado por
   * nosotros y no haber expirado, que es el piso que había antes de esto.
   */
  private async sigueValiendo(userId: string, emitido: number): Promise<boolean> {
    const ahora = Date.now();
    const guardado = this.comprobadas.get(userId);
    if (guardado && guardado.hasta > ahora) {
      return emitido * 1000 >= guardado.tokensDesde;
    }

    let user;
    try {
      user = await this.users.findById(userId);
    } catch {
      return true;
    }

    if (!user) {
      this.comprobadas.delete(userId);
      return false;
    }

    const tokensDesde = user.tokensDesde ? new Date(user.tokensDesde).getTime() : 0;
    this.comprobadas.set(userId, { hasta: ahora + AuthGuard.CACHE_MS, tokensDesde });
    // `iat` viene en segundos; el margen de 1 s cubre el redondeo de firmar
    // y revocar dentro del mismo segundo.
    return emitido * 1000 + 1000 >= tokensDesde;
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
    payload: { sub: string; username?: string; org?: string; rol?: string; exp: number },
  ): Promise<void> {
    const restanteMs = payload.exp * 1000 - Date.now();
    if (restanteMs > (this.sessionHours * 3600_000) / 2) return;

    const res = context.switchToHttp().getResponse<FastifyReply>();
    // Bearer (herramientas/API) no usa cookie: no hay nada que renovar.
    if (typeof res?.setCookie !== 'function') return;

    /*
     * El token renovado lleva TODO lo que llevaba el original.
     *
     * Antes se firmaba solo con `sub` y `username`: a las seis horas de uso
     * la renovación le borraba la organización y el rol a quien estaba
     * trabajando. Sin organización, el aislamiento devuelve vacío —la
     * consola se quedaba en blanco sola— y sin rol, un administrador pasaba
     * a ser usuario común. Pasaba callado y a mitad de jornada.
     */
    const token = await this.jwt.signAsync({
      sub: payload.sub,
      username: payload.username,
      org: payload.org,
      rol: payload.rol,
    });
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
