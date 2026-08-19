import { Controller, Get, HttpCode, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappInboundService } from '../../channels/whatsapp-inbound.service';
import { WebhookLogService } from '../../shared/webhook-log.service';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';

/**
 * Webhook de WhatsApp Cloud API (Meta directo).
 *
 *  GET  /webhooks/whatsapp — verificación: Meta manda hub.mode, hub.verify_token
 *       y hub.challenge; hay que devolver el challenge tal cual si el token coincide.
 *  POST /webhooks/whatsapp — mensajes entrantes. Siempre responde 200: Meta
 *       reintenta durante 36 h ante cualquier error.
 */
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly logger = new Logger('WhatsAppWebhook');

  constructor(
    private readonly inbound: WhatsappInboundService,
    private readonly webhookLog: WebhookLogService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: any) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN', '');

    if (mode === 'subscribe' && expected && token === expected) {
      this.logger.log('Webhook verificado por Meta');
      // El challenge se devuelve como texto plano, no como JSON.
      return res.type('text/plain').send(challenge);
    }
    this.logger.warn('Verificación de webhook rechazada (verify token no coincide)');
    return res.status(403).send('Forbidden');
  }

  @Post()
  @HttpCode(200)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Req() req: { body?: Record<string, unknown> }) {
    const body = req.body ?? {};
    this.webhookLog.push('whatsapp-cloud', 'Evento recibido de Meta', true, JSON.parse(JSON.stringify(body).slice(0, 700)));

    try {
      await this.inbound.process(body, 'whatsapp-cloud');
    } catch (err) {
      // Nunca devolver error: Meta reintentaría el mismo evento durante 36 h.
      this.logger.error(`Error procesando evento de WhatsApp: ${(err as Error).message}`);
      this.webhookLog.push('whatsapp-cloud', `Error procesando evento: ${(err as Error).message}`, false);
    }
    return { received: true };
  }
}
