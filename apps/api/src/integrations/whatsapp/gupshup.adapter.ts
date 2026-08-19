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
    return this.sendToPhone(to, message);
  }

  /** Envío directo por teléfono E.164 (lo usa también el diagnóstico). */
  async sendToPhone(to: string, message: string): Promise<{ delivered: boolean; providerId?: string }> {
    const { status, data } = await this.postMessage(to, message);

    // Gupshup responde 200/202 incluso cuando rechaza el mensaje: el veredicto
    // está en el body (`status: "submitted"` es el caso bueno).
    const estado = String(data?.status ?? '').toLowerCase();
    const ok = status < 400 && ['submitted', 'success', 'sent', 'queued'].includes(estado);

    if (!ok) {
      const detalle = this.describeError(status, data);
      this.logger.warn(`Gupshup rechazó el mensaje a ${to}: ${detalle}`);
      throw new ServiceUnavailableException(`Gupshup: ${detalle}`);
    }

    this.logger.log(`→ WhatsApp (Gupshup) a ${to} — ${estado} ${data?.messageId ?? ''}`);
    return { delivered: true, providerId: data?.messageId };
  }

  /** POST crudo: devuelve status y body sin interpretar (para diagnóstico). */
  async postMessage(
    to: string,
    message: string,
  ): Promise<{ status: number; data: GupshupResponse; sent: Record<string, string> }> {
    const params = {
      channel: 'whatsapp',
      source: this.source,
      destination: to.replace(/^\+/, ''),
      'src.name': this.appName,
      message: JSON.stringify({ type: 'text', text: message }),
    };
    const body = new URLSearchParams(params);

    try {
      const res = await firstValueFrom(
        this.http.post<GupshupResponse>(this.apiUrl, body.toString(), {
          headers: {
            apikey: this.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
          },
          timeout: 15_000,
          // Que un 4xx no lance: el body trae el motivo y queremos reportarlo.
          validateStatus: () => true,
        }),
      );
      return { status: res.status, data: res.data ?? {}, sent: { ...params, message: params.message } };
    } catch (err) {
      // Error de red/timeout: no hubo respuesta del proveedor.
      throw new ServiceUnavailableException(`Gupshup no respondió: ${(err as Error).message}`);
    }
  }

  /** Traduce los rechazos más comunes del sandbox a algo accionable. */
  private describeError(status: number, data: GupshupResponse): string {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    const msg = String(data?.message ?? '');

    if (status === 401 || /unauthor|invalid.*(api|key)/i.test(msg)) {
      return `credenciales rechazadas (revisá GUPSHUP_API_KEY). Respuesta: ${raw}`;
    }
    if (/app.*not.*found|src\.?name/i.test(msg)) {
      return `Gupshup no reconoce la app (revisá GUPSHUP_APP_NAME). Respuesta: ${raw}`;
    }
    if (/source|sender/i.test(msg)) {
      return `número emisor inválido (revisá GUPSHUP_SOURCE_NUMBER, sin '+'). Respuesta: ${raw}`;
    }
    if (/opt.?in|24|window|session/i.test(msg)) {
      return `el destinatario no tiene sesión abierta: tiene que escribirle primero al número del sandbox (o usar plantilla). Respuesta: ${raw}`;
    }
    return `HTTP ${status} — ${raw}`;
  }
}

/** Respuesta de la API de Gupshup (los campos varían según el caso). */
interface GupshupResponse {
  status?: string;
  messageId?: string;
  message?: string;
  [key: string]: unknown;
}
