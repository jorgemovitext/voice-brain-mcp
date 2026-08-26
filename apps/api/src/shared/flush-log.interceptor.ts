import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { WebhookLogService } from './webhook-log.service';

/**
 * Cierra la escritura de la bitácora antes de responder.
 *
 * En serverless la instancia se congela apenas sale la respuesta, así que un
 * guardado disparado y no esperado se pierde. Como la copia en memoria muere
 * con la instancia, el evento no queda en ningún lado: Actividad aparecía
 * vacía y "¿Gupshup nos llamó alguna vez?" siempre respondía que no, aunque
 * nos hubiera llamado.
 *
 * Va como interceptor y no como un `await` en cada controlador porque los
 * webhooks tienen muchas salidas —ocho solo en el de NL Pearl— y basta que a
 * una se le olvide para que el síntoma vuelva sin explicación.
 *
 * Cuando no hay nada agendado, `flush()` espera una promesa ya resuelta: no
 * le cuesta nada a las peticiones normales de la consola.
 */
@Injectable()
export class FlushLogInterceptor implements NestInterceptor {
  constructor(private readonly webhookLog: WebhookLogService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      switchMap((valor) => from(this.webhookLog.flush().then(() => valor))),
    );
  }
}
