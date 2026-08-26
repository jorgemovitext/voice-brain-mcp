import { Injectable, Logger } from '@nestjs/common';
import { AtencionService } from '../shared/atencion.service';
import { BrainService } from '../brain/brain.service';
import { WebhookLogService } from '../shared/webhook-log.service';

/**
 * Procesa los eventos entrantes de WhatsApp, vengan en el formato que vengan.
 *
 * Gupshup puede entregar DOS formas distintas según cómo esté configurada la
 * app: su formato propio v2 (`{type:'message', payload:{...}}`) o el formato
 * de Meta/Cloud API (`{entry:[{changes:[{value:{messages:[...]}}]}]}`).
 * Detectarlo acá evita depender de qué endpoint se configuró en el proveedor
 * y que un mensaje se pierda en silencio por no reconocer el shape.
 *
 * QUÉ ENTRA AL HILO Y QUÉ NO. Los ciudadanos conversan con los agentes por
 * el canal de texto de NL Pearl, no por el nuestro: si todo lo que llega acá
 * entrara al Brain, aparecerían hilos duplicados y sin agente en
 * Conversaciones. Por eso, de base, esto es solo bitácora (y así se
 * diagnostica también la entrega del OTP).
 *
 * La excepción son los hilos TOMADOS. Cuando un operador toma una
 * conversación, la app le escribe al ciudadano por Gupshup — y la respuesta
 * vuelve por acá. Dejarla solo en la bitácora hacía que el operador escribiera
 * a ciegas: el ciudadano contestaba y en la consola no aparecía nada. Si el
 * número tiene un hilo tomado, su mensaje ES de esa conversación y entra.
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
    private readonly brain: BrainService,
    private readonly atencion: AtencionService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  /** Punto de entrada único: detecta el formato y procesa. */
  async process(body: Record<string, unknown>, origen: 'gupshup' | 'whatsapp-cloud'): Promise<void> {
    const mensajes = this.esFormatoMeta(body)
      ? this.parseMeta(body, origen)
      : this.parseGupshup(body, origen);

    for (const m of mensajes) {
      if (this.yaVisto(m.id)) continue;

      const contactId = await this.hiloTomado(m.from);
      if (!contactId) {
        this.logger.log(`← ${origen} de ${m.from}: "${m.text}" (solo bitácora)`);
        this.webhookLog.push(
          origen,
          `Mensaje de ${m.profileName ?? m.from}: “${m.text}” — sin hilo tomado, no entra al Brain`,
          true,
          { from: m.from },
        );
        continue;
      }

      /*
       * Entra como mensaje del ciudadano en el hilo que el operador atiende.
       * NO se auto-responde: el hilo lo tiene una persona, y una respuesta
       * automática encima sería una segunda voz contestando.
       */
      await this.brain.appendInteraction({
        contactId,
        channel: 'whatsapp',
        direction: 'inbound',
        occurredAt: new Date().toISOString(),
        summary: m.text,
        source: 'own',
      });
      this.logger.log(`← ${origen} de ${m.from}: "${m.text}" → hilo tomado`);
      this.webhookLog.push(
        origen,
        `Respuesta de ${m.profileName ?? m.from} en un hilo tomado: “${m.text}”`,
        true,
        { from: m.from },
      );
    }
  }

  /**
   * El contacto de ese número, SOLO si su conversación está tomada por una
   * persona. Devuelve null en cualquier otro caso — incluido un número que
   * nunca escribió, para no crear hilos fantasma desde este canal.
   */
  private async hiloTomado(telefono: string): Promise<string | null> {
    try {
      // `findByPhone` y no `resolveIdentity`: preguntar no debe dar de alta a
      // nadie. Con resolveIdentity, un mensaje de un número desconocido
      // dejaba un contacto fantasma en Conversaciones.
      const contacto = await this.brain.findByPhone(telefono);
      if (!contacto) return null;
      const { operador } = await this.atencion.de(contacto.id);
      return operador ? contacto.id : null;
    } catch (err) {
      this.logger.warn(`No se pudo resolver ${telefono}: ${(err as Error).message}`);
      return null;
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
