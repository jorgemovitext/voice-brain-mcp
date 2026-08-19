import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { BrainService } from '../../brain/brain.service';
import { Channel } from '../../brain/types';
import { ChannelPort } from '../../ports/channel.port';

/**
 * Canal WhatsApp vía Gupshup (BSP). A diferencia de la Cloud API de Meta, el
 * envío va como form-urlencoded y el mensaje viaja como JSON dentro del campo
 * `message`:
 *
 *   POST https://api.gupshup.io/wa/api/v1/msg
 *   apikey: <API KEY>
 *   Content-Type: application/x-www-form-urlencoded
 *   channel=whatsapp&source=<número>&destination=<número>&src.name=<app>
 *   &message={"type":"text","text":"..."}
 *
 * Los números van sin '+' (el Brain los guarda en E.164, así que se quita).
 */
@Injectable()
export class GupshupAdapter implements ChannelPort {
  readonly channel: Channel = 'whatsapp';
  private readonly logger = new Logger('Gupshup');

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly appName: string;
  private readonly source: string;

  constructor(
    private readonly http: HttpService,
    private readonly brain: BrainService,
    config: ConfigService,
  ) {
    this.apiUrl = config.get<string>('GUPSHUP_API_URL', 'https://api.gupshup.io/wa/api/v1/msg');
    this.apiKey = config.get<string>('GUPSHUP_API_KEY', '');
    this.appName = config.get<string>('GUPSHUP_APP_NAME', '');
    this.source = config.get<string>('GUPSHUP_SOURCE_NUMBER', '').replace(/^\+/, '');
  }

  async send(contactId: string, message: string): Promise<{ delivered: boolean; providerId?: string }> {
    const ctx = await this.brain.getContext({ contactId });
    const to = ctx.contact.phones[0];
    if (!to) throw new ServiceUnavailableException(`El contacto ${contactId} no tiene teléfono`);

    const body = new URLSearchParams({
      channel: 'whatsapp',
      source: this.source,
      destination: to.replace(/^\+/, ''),
      'src.name': this.appName,
      message: JSON.stringify({ type: 'text', text: message }),
    });

    try {
      const res = await firstValueFrom(
        this.http.post<{ status?: string; messageId?: string }>(this.apiUrl, body.toString(), {
          headers: {
            apikey: this.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
          },
          timeout: 15_000,
        }),
      );

      const providerId = res.data.messageId;
      this.logger.log(`→ WhatsApp (Gupshup) a ${to} — ${res.data.status ?? 'enviado'} ${providerId ?? ''}`);
      return { delivered: true, providerId };
    } catch (err) {
      const data = (err as { response?: { data?: unknown } }).response?.data;
      const detalle = typeof data === 'string' ? data : JSON.stringify(data ?? (err as Error).message);
      this.logger.warn(`Gupshup falló para ${to}: ${detalle}`);
      throw new ServiceUnavailableException(`Gupshup: ${detalle}`);
    }
  }
}
