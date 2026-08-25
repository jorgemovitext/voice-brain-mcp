import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Firma de los eventos del canal Generic de NL Pearl.
 *
 * La documentación fija el esquema: cabeceras `X-Pearl-Timestamp` y
 * `X-Pearl-Signature`, y el HMAC-SHA256 se calcula sobre la cadena
 * `"{timestamp}.{cuerpoCrudo}"` con el secreto del canal.
 *
 * Falla CERRADO, igual que `TurnCredentialGuard`: por acá entran mensajes que
 * se guardan en el hilo del ciudadano, y sin firma cualquiera que conozca la
 * URL podría inventar lo que dijo el agente o la persona.
 */
@Injectable()
export class GenericChannelGuard implements CanActivate {
  private readonly logger = new Logger(GenericChannelGuard.name);
  /** Ventana de tolerancia: frena reenviar un evento capturado hace rato. */
  private static readonly VENTANA_MS = 5 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secreto = this.config.get<string>('NLPEARL_GENERIC_SECRET', '');
    if (!secreto) {
      this.logger.error('NLPEARL_GENERIC_SECRET sin configurar: se rechaza el evento');
      throw new UnauthorizedException('El canal de mensajes no tiene credencial configurada');
    }

    const req = context.switchToHttp().getRequest();
    const timestamp = (req.headers['x-pearl-timestamp'] as string) ?? '';
    const firma = (req.headers['x-pearl-signature'] as string) ?? '';
    if (!timestamp || !firma) throw new UnauthorizedException('Faltan las cabeceras de firma');

    const cuando = Date.parse(timestamp);
    if (Number.isFinite(cuando) && Math.abs(Date.now() - cuando) > GenericChannelGuard.VENTANA_MS) {
      this.logger.warn('Evento del canal Generic fuera de la ventana de tiempo');
      throw new UnauthorizedException('Evento vencido');
    }

    const crudo: Buffer | string = req.rawBody ?? JSON.stringify(req.body ?? {});
    const esperada = createHmac('sha256', secreto)
      .update(`${timestamp}.${typeof crudo === 'string' ? crudo : crudo.toString('utf-8')}`)
      .digest('hex');

    // El proveedor puede mandarla en hex plano o prefijada; se acepta cualquiera.
    const recibida = firma.replace(/^sha256=/i, '').trim();
    const a = Buffer.from(recibida, 'utf-8');
    const b = Buffer.from(esperada, 'utf-8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('Evento del canal Generic con firma inválida rechazado');
      throw new UnauthorizedException('Firma inválida');
    }
    return true;
  }
}
