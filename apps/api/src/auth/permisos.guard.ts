import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';
import { NOMBRE_PERMISO, Permiso, puede } from './permisos';

export const PERMISO_KEY = 'permisoRequerido';

/**
 * Qué permiso hace falta para este endpoint.
 *
 *   @Requiere('conversar')
 *   @Post(':id/mensaje')
 *
 * Sin el decorador, el guard decide por el método HTTP (ver abajo).
 */
export const Requiere = (permiso: Permiso) => SetMetadata(PERMISO_KEY, permiso);

/**
 * Guard GLOBAL de permisos. Corre después del de sesión: acá ya se sabe
 * QUIÉN es; lo que falta es si puede.
 *
 * La regla que lo hace seguro de verdad no es el decorador, es el DEFAULT:
 *
 *  - Con `@Requiere(...)`: se exige ese permiso.
 *  - Sin decorador y método que ESCRIBE (POST/PATCH/PUT/DELETE): se exige
 *    administrador.
 *  - Sin decorador y método que LEE (GET/HEAD): pasa cualquiera con sesión.
 *
 * O sea: olvidarse del decorador en un endpoint que modifica algo lo deja
 * cerrado de más —solo el administrador— y no abierto a cualquiera. Es la
 * misma elección que el guard de sesión: el olvido tiene que fallar del lado
 * seguro, porque los olvidos ocurren.
 *
 * Las lecturas quedan abiertas a los dos roles a propósito. Un `usuario`
 * atiende conversaciones: cerrarle las lecturas por omisión sería dejarlo
 * sin la pantalla donde trabaja, y la respuesta sería poner decoradores en
 * decenas de GET para volver al mismo lugar. Lo que de verdad hay que
 * proteger de la lectura —el consumo y la factura— lleva su decorador.
 */
@Injectable()
export class PermisosGuard implements CanActivate {
  private static readonly ESCRIBEN = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const publico = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Lo público no tiene sesión de la que sacar un rol: los webhooks del
    // proveedor entran por acá y no son nadie del equipo.
    if (publico) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { rol?: string } }>();
    const rol = req.user?.rol;

    const declarado = this.reflector.getAllAndOverride<Permiso>(PERMISO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (declarado) {
      if (puede(rol, declarado)) return true;
      throw new ForbiddenException(
        `Esto es del administrador: ${NOMBRE_PERMISO[declarado].toLowerCase()}.`,
      );
    }

    const metodo = (req.method ?? 'GET').toUpperCase();
    if (!PermisosGuard.ESCRIBEN.has(metodo)) return true;

    if (rol === 'admin') return true;
    throw new ForbiddenException('Solo el administrador de la cuenta puede hacer este cambio.');
  }
}
