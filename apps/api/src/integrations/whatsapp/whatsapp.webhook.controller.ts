import { Controller, Get, HttpCode, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FollowupService } from '../../channels/followup.service';
import { WhatsappSignatureGuard } from './whatsapp-signature.guard';

/** Forma del evento entrante de la Cloud API (parcial, lo que consumimos). */
interface WhatsappWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

/**
 * Webhook de WhatsApp Cloud API (nuestra WABA).
 *
 *  GET  /webhooks/whatsapp — verificación: Meta manda hub.mode, hub.verify_token
 *       y hub.challenge; hay que devolver el challenge tal cual si el token coincide.
 *  POST /webhooks/whatsapp — mensajes entrantes. Siempre responde 200: Meta
 *       reintenta durante 36 h ante cualquier error, así que los problemas se
 *       registran pero no se propagan.
 */
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly logger = new Logger('WhatsAppWebhook');

  /** IDs ya procesados: Meta reintenta y no queremos duplicar mensajes. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly followup: FollowupService,
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
  async receive(@Req() req: { body?: WhatsappWebhookBody }) {
    const body = req.body ?? {};
    try {
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          const profileName = value.contacts?.[0]?.profile?.name;

          for (const message of value.messages ?? []) {
            if (!message.id || this.seen.has(message.id)) continue;
            this.rememberId(message.id);

            if (message.type !== 'text' || !message.text?.body || !message.from) {
              this.logger.log(`Mensaje ${message.type ?? 'desconocido'} ignorado (solo se procesa texto)`);
              continue;
            }

            // Meta entrega el número sin '+'; el Brain llavea en E.164.
            const from = message.from.startsWith('+') ? message.from : `+${message.from}`;
            this.logger.log(`← WhatsApp de ${from}: "${message.text.body}"`);
            await this.followup.receiveInbound('whatsapp', from, message.text.body, profileName);
          }
        }
      }
    } catch (err) {
      // Nunca devolver error: Meta reintentaría el mismo evento durante 36 h.
      this.logger.error(`Error procesando evento de WhatsApp: ${(err as Error).message}`);
    }
    return { received: true };
  }

  private rememberId(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 500) {
      // Poda simple para que el set no crezca sin límite.
      for (const old of this.seen) {
        this.seen.delete(old);
        if (this.seen.size <= 400) break;
      }
    }
  }
}
