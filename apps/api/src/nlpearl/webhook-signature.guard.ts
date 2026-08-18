import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Verifica el "Credential" del webhook de NL Pearl.
 *
 * Según la doc oficial (developers.nlpearl.ai/pages/webhooks), NL Pearl NO
 * firma con HMAC: al configurar el webhook podés adjuntar un Credential
 * (token) que se envía en cada entrega para autenticar el origen.
 * El valor lo creás vos en NL Pearl (settings del Pearl → Webhooks →
 * credential) y debe coincidir con NLPEARL_WEBHOOK_SECRET del .env.
 *
 * Sin secreto configurado, deja pasar (modo dev/mock).
 * // TODO: confirmar con NL Pearl el header exacto en que viaja el credential
 * //       (acá se aceptan `Authorization: Bearer <token>` y `x-nlpearl-credential`).
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
