import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { BrainService } from '../../brain/brain.service';
import { Channel } from '../../brain/types';
import { ChannelPort } from '../../ports/channel.port';

/**
 * Canal WhatsApp real sobre la Cloud API de Meta (WABA propia).
 *
 * Envío (docs Meta):
 *   POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages
 *   Authorization: Bearer {ACCESS_TOKEN}
 *   { messaging_product, recipient_type, to, type: "text", text: { body } }
 *
 * Ojo con la ventana de 24h: fuera de ella, Meta solo acepta plantillas
 * aprobadas. Un texto libre falla con error 131047 y acá se traduce a un
 * mensaje entendible en vez de un 500 opaco.
 */
@Injectable()
export class WhatsappCloudAdapter implements ChannelPort {
  readonly channel: Channel = 'whatsapp';
  private readonly logger = new Logger('WhatsAppCloud');

  private readonly version: string;
  private readonly phoneNumberId: string;
  private readonly token: string;

  constructor(
    private readonly http: HttpService,
    private readonly brain: BrainService,
    config: ConfigService,
  ) {
    this.version = config.get<string>('WHATSAPP_API_VERSION', 'v21.0');
    this.phoneNumberId = config.get<string>('WHATSAPP_PHONE_NUMBER_ID', '');
    this.token = config.get<string>('WHATSAPP_TOKEN', '');
  }

  async send(contactId: string, message: string): Promise<{ delivered: boolean; providerId?: string }> {
    const ctx = await this.brain.getContext({ contactId });
    const to = ctx.contact.phones[0];
    if (!to) throw new ServiceUnavailableException(`El contacto ${contactId} no tiene teléfono`);

    const url = `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`;
    try {
      const res = await firstValueFrom(
        this.http.post<{ messages?: Array<{ id: string }> }>(
          url,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to.replace(/^\+/, ''), // Meta espera el E.164 sin el '+'
            type: 'text',
            text: { preview_url: false, body: message },
          },
          {
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            timeout: 15_000,
          },
        ),
      );

      const providerId = res.data.messages?.[0]?.id;
      this.logger.log(`→ WhatsApp a ${to} (${providerId ?? 'sin id'})`);
      return { delivered: true, providerId };
    } catch (err) {
      const meta = (err as { response?: { data?: { error?: { code?: number; message?: string } } } }).response?.data
        ?.error;
      // 131047: fuera de la ventana de 24h → hace falta una plantilla aprobada.
      const detalle =
        meta?.code === 131047
          ? 'Fuera de la ventana de 24 horas: WhatsApp solo permite plantillas aprobadas hasta que el cliente vuelva a escribir.'
          : (meta?.message ?? (err as Error).message);
      this.logger.warn(`WhatsApp falló para ${to}: ${detalle}`);
      throw new ServiceUnavailableException(`WhatsApp: ${detalle}`);
    }
  }
}
