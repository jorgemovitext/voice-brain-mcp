import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

/**
 * Freno por IP para los endpoints públicos de autenticación.
 *
 * Existe un bloqueo por CUENTA (5 fallos → 15 min), pero nada frenaba a una IP
 * que probara muchas cuentas distintas, ni la creación masiva de cuentas por
 * el registro abierto. Esto acota ambas cosas sin tocar el flujo normal: un
 * humano hace 1–3 peticiones para entrar; el tope es holgado para eso y
 * estrecho para un bot.
 *
 * Falla ABIERTO a propósito. Si algo interno se rompe, se deja pasar en vez de
 * trabar el login: perder el freno un rato es preferible a dejar a los
 * operadores afuera. Y solo se aplica a los cuatro endpoints públicos de auth
 * (login/register/resend-otp/verify-otp): `/me` —que la consola sí consulta al
 * navegar— y todo el resto quedan intactos.
 *
 * La ventana vive en memoria de instancia. En serverless eso significa por
 * lambda, así que el tope efectivo se multiplica por instancias calientes;
 * aun así agrega fricción real y nunca traba a un usuario legítimo. Un freno
 * distribuido de verdad necesitaría un store compartido (Redis), que es más
 * de lo que este riesgo amerita hoy.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  /** 20 intentos por IP cada 5 minutos: sobra para una persona, molesta a un bot. */
  private static readonly VENTANA_MS = 5 * 60_000;
  private static readonly TOPE = 20;

  /** IP → marcas de tiempo de sus peticiones dentro de la ventana. */
  private readonly golpes = new Map<string, number[]>();
  private ultimaLimpieza = 0;

  canActivate(context: ExecutionContext): boolean {
    try {
      const req = context.switchToHttp().getRequest();
      const ip = this.ipDe(req);
      const ahora = Date.now();

      this.limpiar(ahora);

      const recientes = (this.golpes.get(ip) ?? []).filter((t) => ahora - t < RateLimitGuard.VENTANA_MS);
      if (recientes.length >= RateLimitGuard.TOPE) {
        this.logger.warn(`Demasiados intentos de auth desde ${ip}: ${recientes.length} en la ventana`);
        throw new HttpException('Demasiados intentos. Esperá unos minutos.', HttpStatus.TOO_MANY_REQUESTS);
      }

      recientes.push(ahora);
      this.golpes.set(ip, recientes);
      return true;
    } catch (err) {
      // El 429 es intencional y debe propagarse; cualquier OTRO error deja pasar.
      if (err instanceof HttpException) throw err;
      this.logger.error(`Freno de auth deshabilitado por error interno: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * IP del cliente. En Vercel la real viaja en `x-forwarded-for` (el primer
   * valor de la lista); `req.ip` sería la del proxy y metería a todos en el
   * mismo balde. Si no hay ninguna, se usa una clave fija: peor tope, nunca
   * un crash.
   */
  private ipDe(req: { headers?: Record<string, unknown>; ip?: string }): string {
    const fwd = req.headers?.['x-forwarded-for'];
    const primera = (Array.isArray(fwd) ? fwd[0] : String(fwd ?? '')).split(',')[0]?.trim();
    return primera || req.ip || 'desconocida';
  }

  /** Purga IPs sin actividad reciente, como mucho una vez por ventana. */
  private limpiar(ahora: number): void {
    if (ahora - this.ultimaLimpieza < RateLimitGuard.VENTANA_MS) return;
    this.ultimaLimpieza = ahora;
    for (const [ip, marcas] of this.golpes) {
      if (marcas.every((t) => ahora - t >= RateLimitGuard.VENTANA_MS)) this.golpes.delete(ip);
    }
  }
}
