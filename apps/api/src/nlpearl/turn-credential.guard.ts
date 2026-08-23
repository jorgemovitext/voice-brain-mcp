import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Credencial del endpoint de turnos en vivo (`/webhooks/nlpearl/turno`).
 *
 * Va aparte de `WebhookSignatureGuard` porque las dos entradas tienen dueños
 * distintos:
 *
 *  - El Call Webhook lo llama NL Pearl con SU credencial, que la plataforma
 *    activa y mantiene interna: no la revela, así que no hay valor contra el
 *    cual compararla de nuestro lado.
 *  - Este endpoint lo llama el nodo API del flujo, y las cabeceras de ese nodo
 *    las configuramos nosotros. O sea, acá SÍ elegimos el secreto.
 *
 * Por eso este guard falla cerrado: sin `NLPEARL_TURN_SECRET` no se acepta
 * nada. El endpoint escribe en el historial de conversaciones, y dejarlo
 * abierto permitiría a cualquiera que conozca la URL inventar mensajes de un
 * ciudadano o poner palabras en boca del agente.
 */
@Injectable()
export class TurnCredentialGuard implements CanActivate {
  private readonly logger = new Logger(TurnCredentialGuard.name);
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret =
      config.get<string>('NLPEARL_TURN_SECRET', '') || config.get<string>('NLPEARL_WEBHOOK_SECRET', '');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) {
      this.logger.error('NLPEARL_TURN_SECRET sin configurar: se rechaza el turno');
      throw new UnauthorizedException('El endpoint de turnos no tiene credencial configurada');
    }

    const req = context.switchToHttp().getRequest();
    const auth = (req.headers['authorization'] as string) ?? '';
    const custom = (req.headers['x-nlpearl-credential'] as string) ?? '';
    const token = custom || auth.replace(/^Bearer\s+/i, '');

    if (!this.safeEquals(token, this.secret)) {
      this.logger.warn('Turno con credencial inválida rechazado');
      throw new UnauthorizedException('Credencial inválida');
    }
    return true;
  }

  private safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
