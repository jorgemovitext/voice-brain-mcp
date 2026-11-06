import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';

export const SOLO_PLATAFORMA = 'soloPlataforma';

/**
 * Marca un endpoint como del DUEÑO de la plataforma, no de un cliente.
 *
 *   @SoloPlataforma()
 *   @Get('clientes')
 */
export const SoloPlataforma = () => SetMetadata(SOLO_PLATAFORMA, true);

/**
 * La puerta del back-office.
 *
 * Es la única parte del sistema que ve a TODOS los clientes, así que es la
 * única que puede romper el aislamiento. Por eso no se apoya en un rol: los
 * roles se cambian desde la pantalla de equipo, y si «ver todo» dependiera
 * del rol, al administrador de cualquier cliente le bastaría con ascenderse
 * a sí mismo para ver la facturación de la competencia.
 *
 * Depende del tipo de EMPRESA, que solo se cambia en la base. El dato viaja
 * en el token —firmado por nosotros— y se calcula al entrar.
 */
@Injectable()
export class PlataformaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const exige = this.reflector.getAllAndOverride<boolean>(SOLO_PLATAFORMA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!exige) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { plataforma?: boolean } }>();
    if (req.user?.plataforma === true) return true;

    /*
     * «No existe» y no «no tenés permiso»: un 403 explícito le confirma a
     * un cliente curioso que el back-office existe y dónde vive.
     */
    throw new ForbiddenException('No encontramos eso.');
  }
}
