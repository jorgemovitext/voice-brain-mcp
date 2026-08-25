import { Injectable, Logger } from '@nestjs/common';
import { WebhookLogService } from '../shared/webhook-log.service';
import { FollowupService } from './followup.service';

/**
 * Procesa los eventos entrantes de WhatsApp, vengan en el formato que vengan.
 *
 * Gupshup puede entregar DOS formas distintas según cómo esté configurada la
 * app: su formato propio v2 (`{type:'message', payload:{...}}`) o el formato
 * de Meta/Cloud API (`{entry:[{changes:[{value:{messages:[...]}}]}]}`).
 * Detectarlo acá evita depender de qué endpoint se configuró en el proveedor
 * y que un mensaje se pierda en silencio por no reconocer el shape.
 *
 * IMPORTANTE: Gupshup quedó SOLO para entregar los OTP del acceso. Las
 * conversaciones con clientes las atienden los agentes por el canal de texto
 * de NL Pearl, así que lo que llega acá se registra en la bitácora (sirve para
 * diagnosticar la entrega del OTP) pero NO entra al Brain: si entrara,
 * aparecerían hilos duplicados y sin agente en Conversaciones.
 */

interface MensajeNormalizado {
  id: string;
  from: string;
  text: string;
  profileName?: string;
}

@Injectable()
export class WhatsappInboundService {
  private readonly logger = new Logger('WhatsAppInbound');
  /** IDs ya procesados: los proveedores reintentan. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly followup: FollowupService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  /** Punto de entrada único: detecta el formato y procesa. */
  async process(body: Record<string, unknown>, origen: 'gupshup' | 'whatsapp-cloud'): Promise<void> {
    const mensajes = this.esFormatoMeta(body)
      ? this.parseMeta(body, origen)
      : this.parseGupshup(body, origen);

    for (const m of mensajes) {
      if (this.yaVisto(m.id)) continue;
      this.logger.log(`← ${origen} de ${m.from}: "${m.text}" (solo bitácora)`);
      this.webhookLog.push(
        origen,
        `Mensaje de ${m.profileName ?? m.from}: “${m.text}” — no entra al Brain (este canal es solo para OTP)`,
        true,
        { from: m.from },
      );
    }
  }

  private esFormatoMeta(body: Record<string, unknown>): boolean {
    return Array.isArray(body['entry']);
  }

  /** Formato Meta / Cloud API (el que usa Gupshup cuando va en passthrough). */
  private parseMeta(body: Record<string, unknown>, origen: string): MensajeNormalizado[] {
    const salida: MensajeNormalizado[] = [];

    for (const entry of (body['entry'] as Array<Record<string, unknown>>) ?? []) {
      for (const change of (entry['changes'] as Array<Record<string, unknown>>) ?? []) {
        const value = (change['value'] as Record<string, unknown>) ?? {};

        // Acuses de entrega: se registran, no entran al hilo del contacto.
        const statuses = value['statuses'] as Array<Record<string, unknown>> | undefined;
        for (const s of statuses ?? []) {
          const estado = String(s['status'] ?? 'desconocido');
          this.webhookLog.push(
            origen as 'gupshup',
            `Acuse de entrega: ${estado} → ${String(s['recipient_id'] ?? '')}`,
            estado !== 'failed',
          );
        }

        const contactos = (value['contacts'] as Array<Record<string, unknown>>) ?? [];
        const profileName = ((contactos[0]?.['profile'] as Record<string, unknown>)?.['name'] as string) ?? undefined;

        for (const msg of (value['messages'] as Array<Record<string, unknown>>) ?? []) {
          const texto =
            ((msg['text'] as Record<string, unknown>)?.['body'] as string) ??
            ((msg['button'] as Record<string, unknown>)?.['text'] as string) ??
            (((msg['interactive'] as Record<string, unknown>)?.['button_reply'] as Record<string, unknown>)?.[
              'title'
            ] as string);
          const from = msg['from'] as string | undefined;

          if (!texto || !from) {
            this.logger.log(`Mensaje ${String(msg['type'])} ignorado (solo se procesa texto)`);
            continue;
          }
          salida.push({
            id: String(msg['id'] ?? `${from}-${msg['timestamp']}`),
            from: from.startsWith('+') ? from : `+${from}`,
            text: texto,
            profileName,
          });
        }
      }
    }
    return salida;
  }

  /** Formato propio de Gupshup (v2). */
  private parseGupshup(body: Record<string, unknown>, origen: string): MensajeNormalizado[] {
    const tipo = body['type'];
    const payload = (body['payload'] as Record<string, unknown>) ?? {};

    if (tipo === 'message-event') {
      /*
       * Gupshup acusa recibo con `submitted` en el momento del envío aunque
       * el mensaje después no llegue: el veredicto real viene acá. Sin el
       * motivo, un "failed" a secas no sirve de nada — es justo el dato que
       * explica por qué una plantilla aceptada nunca aparece en el teléfono.
       */
      const estado = String(payload['type'] ?? 'desconocido');
      const detalle = (payload['payload'] as Record<string, unknown>) ?? {};
      const motivo = [detalle['code'], detalle['reason']].filter(Boolean).join(' · ');
      const destino = payload['destination'] ? ` a ${String(payload['destination'])}` : '';
      this.webhookLog.push(
        origen as 'gupshup',
        `Acuse de entrega${destino}: ${estado}${motivo ? ` — ${motivo}` : ''}`,
        estado !== 'failed',
        payload,
      );
      return [];
    }
    if (tipo !== 'message') return [];

    const interno = (payload['payload'] as Record<string, unknown>) ?? {};
    const sender = (payload['sender'] as Record<string, unknown>) ?? {};
    const texto = (interno['text'] ?? interno['title'] ?? interno['postbackText']) as string | undefined;
    const phone = (sender['phone'] ?? payload['source']) as string | undefined;

    if (!texto || !phone) return [];
    return [
      {
        id: String(payload['id'] ?? `${phone}-${Date.now()}`),
        from: phone.startsWith('+') ? phone : `+${phone}`,
        text: texto,
        profileName: sender['name'] as string | undefined,
      },
    ];
  }

  private yaVisto(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > 500) {
      for (const viejo of this.seen) {
        this.seen.delete(viejo);
        if (this.seen.size <= 400) break;
      }
    }
    return false;
  }
}
