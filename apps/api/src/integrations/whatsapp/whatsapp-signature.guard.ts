import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Valida la firma de los eventos de Meta: header `X-Hub-Signature-256` con
 * formato `sha256={hmac}`, calculado con el App Secret sobre el cuerpo CRUDO.
 *
 * La doc de Meta dice que validar es opcional pero recomendado; acá se exige
 * solo si hay App Secret configurado, para no bloquear las pruebas iniciales.
 */
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const appSecret = this.config.get<string>('WHATSAPP_APP_SECRET', '');
    if (!appSecret) return true; // sin App Secret no se exige firma

    const req = context.switchToHttp().getRequest();
    const header = (req.headers['x-hub-signature-256'] as string) ?? '';
    const received = header.replace(/^sha256=/, '');

    // El HMAC va sobre el cuerpo crudo: NestFactory se levanta con rawBody:true.
    const raw: Buffer | string = req.rawBody ?? JSON.stringify(req.body ?? {});
    const expected = createHmac('sha256', appSecret).update(raw).digest('hex');

    const a = Buffer.from(received, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('Evento de WhatsApp con firma inválida rechazado');
      throw new UnauthorizedException('Firma inválida');
    }
    return true;
  }
}
