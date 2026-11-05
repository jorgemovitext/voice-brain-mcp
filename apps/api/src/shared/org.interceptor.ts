import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { conContexto } from './contexto-org';

/**
 * Pone la organización de la sesión al alcance de toda la petición.
 *
 * Corre DESPUÉS del guard, así que `req.user` ya está verificado: la
 * organización sale del token firmado y nunca de un parámetro del cliente.
 * Eso es lo que la vuelve aislamiento y no un filtro que el navegador puede
 * cambiar a gusto.
 *
 * En las rutas públicas —webhooks, login— no hay sesión y el contexto queda
 * vacío. Cada consumidor decide: los webhooks resuelven la organización por
 * el número de la línea a la que escribieron, que es su equivalente.
 */
@Injectable()
export class OrgInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { sub?: string; org?: string } }>();
    const org = req?.user?.org;
    if (!org) return next.handle();

    /*
     * `conContexto` envuelve la CREACIÓN del observable, no su suscripción.
     * Con RxJS alcanza: el handler se ejecuta dentro de `next.handle()` y
     * hereda el almacén async. Si algún día algo se suscribiera tarde y
     * fuera del contexto, se notaría como una consulta sin organización —
     * y las consultas sin organización no devuelven nada, que es el modo
     * correcto de fallar.
     */
    return conContexto({ org, usuario: req.user?.sub }, () => next.handle());
  }
}
