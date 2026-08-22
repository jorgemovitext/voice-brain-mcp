import { Public } from '../../auth/public.decorator';
import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { WhatsappInboundService } from '../../channels/whatsapp-inbound.service';
import { WebhookLogService } from '../../shared/webhook-log.service';

/**
 * POST /webhooks/gupshup — webhook único de Gupshup (esta es la URL que se
 * pega en su consola).
 *
 * Gupshup entrega su formato v2 propio o el de Meta/Cloud API según cómo esté
 * configurada la app; WhatsappInboundService detecta cuál llegó. Siempre se
 * responde 200 para que el proveedor no reintente.
 */
// Público: entrada de proveedor externo (verificación propia, no sesión de consola).
@Public()
@Controller('webhooks/gupshup')
export class GupshupWebhookController {
  private readonly logger = new Logger('GupshupWebhook');

  constructor(
    private readonly inbound: WhatsappInboundService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: { body?: Record<string, unknown> }) {
    const body = req.body ?? {};

    // Se registra todo lo que llega: si el proveedor cambia de formato, se ve.
    const formato = Array.isArray(body['entry']) ? 'meta' : `gupshup:${String(body['type'] ?? 'sin type')}`;
    this.webhookLog.push('gupshup', `Evento recibido (${formato})`, true, JSON.parse(JSON.stringify(body).slice(0, 700)));

    try {
      await this.inbound.process(body, 'gupshup');
    } catch (err) {
      this.logger.error(`Error procesando evento de Gupshup: ${(err as Error).message}`);
      this.webhookLog.push('gupshup', `Error procesando evento: ${(err as Error).message}`, false);
    }
    return { received: true };
  }
}
