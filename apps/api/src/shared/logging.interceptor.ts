import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Interceptor simple: método, ruta y duración de cada request. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const started = Date.now();
    return next.handle().pipe(
      tap(() => this.logger.log(`${req.method} ${req.url} — ${Date.now() - started}ms`)),
    );
  }
}
