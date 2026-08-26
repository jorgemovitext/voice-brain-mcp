import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Verifica un token compartido en el webhook de Gupshup.
 *
 * Gupshup no firma sus callbacks con HMAC como Meta, pero deja fijar libremente
 * la URL del callback: se le puede hornear un secreto propio. Con
 * `GUPSHUP_WEBHOOK_TOKEN` seteado, este guard exige ese mismo valor en el
 * header `x-webhook-token` o en `?token=` de la URL — lo que sea que el panel
 * de Gupshup permita en tu plan.
 *
 * Falla ABIERTO cuando el token NO está configurado, igual que el guard de NL
 * Pearl: sin secreto no hay contra qué comparar, así que deja pasar y el
 * comportamiento es idéntico al de hoy. Esto es deliberado — la firma se
 * ACTIVA recién cuando pongas el token en los dos lados (la env y la URL del
 * panel), no antes, para no cortar los mensajes entrantes que ya funcionan.
 *
 * Consecuencia mientras esté vacío: el webhook queda abierto a quien conozca
 * la URL. El daño está acotado porque un entrante solo entra al Brain si su
 * número tiene un hilo TOMADO por un operador (ver WhatsappInboundService); lo
 * demás queda en la bitácora. Aun así, activar el token lo cierra del todo.
 */
@Injectable()
export class GupshupWebhookGuard implements CanActivate {
  private readonly logger = new Logger(GupshupWebhookGuard.name);
  private readonly token: string;

  constructor(config: ConfigService) {
    this.token = config.get<string>('GUPSHUP_WEBHOOK_TOKEN', '');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) return true; // sin token configurado no se exige (passthrough)

    const req = context.switchToHttp().getRequest();
    const header = (req.headers?.['x-webhook-token'] as string) ?? '';
    const query = (req.query?.['token'] as string) ?? '';
    const recibido = header || query;

    if (!this.safeEquals(recibido, this.token)) {
      this.logger.warn('Webhook de Gupshup con token inválido rechazado');
      throw new UnauthorizedException('Token de webhook inválido');
    }
    return true;
  }

  private safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
