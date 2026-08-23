import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Verifica el "Credential" del Call Webhook de NL Pearl.
 *
 * NL Pearl no firma con HMAC: adjunta un Credential que viaja en cada entrega.
 * OJO con la letra chica — esa credencial la activa la plataforma y la
 * mantiene INTERNA: no la muestra ni deja fijarle un valor propio. O sea, del
 * lado nuestro no hay contra qué compararla, y por eso en producción
 * `NLPEARL_WEBHOOK_SECRET` va vacío y este guard deja pasar.
 *
 * Consecuencia asumida: `/webhooks/nlpearl` queda abierto a quien conozca la
 * URL. El daño está acotado porque la ingesta exige un `pearlId` que exista en
 * el espejo de la cuenta, pero no es autenticación. Donde SÍ elegimos nosotros
 * el secreto —el nodo API del flujo, que configuramos— se usa
 * `TurnCredentialGuard`, que falla cerrado.
 *
 * En local el secreto sí está seteado y se exige, que es lo que permite
 * probar el rechazo.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('NLPEARL_WEBHOOK_SECRET', '');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) return true; // sin credencial configurada no se exige

    const req = context.switchToHttp().getRequest();
    const auth = (req.headers['authorization'] as string) ?? '';
    const custom = (req.headers['x-nlpearl-credential'] as string) ?? '';
    const token = custom || auth.replace(/^Bearer\s+/i, '');

    if (!this.safeEquals(token, this.secret)) {
      this.logger.warn('Webhook con credencial inválida rechazado');
      throw new UnauthorizedException('Credencial de webhook inválida');
    }
    return true;
  }

  private safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
