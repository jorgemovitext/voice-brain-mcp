import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { FollowupService } from '../../channels/followup.service';

/**
 * Evento de Gupshup (v2). Dos tipos que nos interesan:
 *  - `message`: mensaje entrante del cliente
 *  - `message-event`: acuse de estado (enqueued/sent/delivered/read/failed)
 */
interface GupshupEvent {
  app?: string;
  timestamp?: number;
  version?: number;
  type?: 'message' | 'message-event' | string;
  payload?: {
    id?: string;
    gsId?: string;
    source?: string;
    type?: string; // text | image | file | button_reply | ...
    destination?: string;
    payload?: { text?: string; title?: string; postbackText?: string };
    sender?: { phone?: string; name?: string; country_code?: string; dial_code?: string };
  };
}

/**
 * POST /webhooks/gupshup — webhook único de Gupshup (esta es la URL que se
 * pega en la consola de Gupshup → Webhooks).
 *
 * Gupshup no firma los eventos como Meta; la protección práctica es que la
 * URL no sea adivinable y validar la forma del payload. Siempre responde 200
 * para que Gupshup no reintente.
 */
@Controller('webhooks/gupshup')
export class GupshupWebhookController {
  private readonly logger = new Logger('GupshupWebhook');

  /** IDs ya procesados: evita duplicar si Gupshup reintenta. */
  private readonly seen = new Set<string>();

  constructor(private readonly followup: FollowupService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: { body?: GupshupEvent }) {
    const event = req.body ?? {};
    try {
      if (event.type === 'message-event') {
        // Acuse de estado: se registra pero no entra al hilo del contacto.
        this.logger.log(
          `Estado de mensaje ${event.payload?.id ?? ''}: ${event.payload?.type ?? 'desconocido'}`,
        );
        return { received: true };
      }

      if (event.type !== 'message') return { received: true, ignored: event.type };

      const p = event.payload ?? {};
      const id = p.id;
      if (!id || this.seen.has(id)) return { received: true, duplicated: true };
      this.rememberId(id);

      // Texto plano o respuesta de botón/lista.
      const text = p.payload?.text ?? p.payload?.title ?? p.payload?.postbackText;
      const phone = p.sender?.phone ?? p.source;
      if (p.type !== 'text' && !text) {
        this.logger.log(`Mensaje de tipo ${p.type} ignorado (solo se procesa texto)`);
        return { received: true, ignored: p.type };
      }
      if (!phone || !text) return { received: true, ignored: 'sin remitente o texto' };

      // Gupshup entrega el número sin '+'; el Brain llavea en E.164.
      const from = phone.startsWith('+') ? phone : `+${phone}`;
      this.logger.log(`← WhatsApp (Gupshup) de ${from}: "${text}"`);
      await this.followup.receiveInbound('whatsapp', from, text, p.sender?.name);
    } catch (err) {
      // Nunca propagar el error: Gupshup reintentaría el mismo evento.
      this.logger.error(`Error procesando evento de Gupshup: ${(err as Error).message}`);
    }
    return { received: true };
  }

  private rememberId(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 500) {
      for (const old of this.seen) {
        this.seen.delete(old);
        if (this.seen.size <= 400) break;
      }
    }
  }
}
