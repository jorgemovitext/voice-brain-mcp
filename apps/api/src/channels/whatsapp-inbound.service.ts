import { Inject, Injectable, Logger } from '@nestjs/common';
import { AtencionService } from '../shared/atencion.service';
import { BrainService } from '../brain/brain.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';

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
  /** Si el mensaje era un archivo y no texto, con qué ícono se muestra. */
  attachment?: 'foto' | 'ubicacion' | 'audio' | 'adjunto';
  /** Enlace al archivo, cuando el proveedor lo entrega. */
  attachmentUrl?: string;
}

/**
 * Qué clase de adjunto es cada tipo de mensaje de WhatsApp, y con qué etiqueta
 * se anuncia en el chat cuando no trae texto.
 *
 * Sin esto, una imagen o un audio se descartaban por no tener `text` y no
 * aparecían nunca en el hilo — el operador no se enteraba de que el ciudadano
 * había mandado algo.
 */
const MEDIA: Record<string, { attachment: 'foto' | 'ubicacion' | 'audio' | 'adjunto'; etiqueta: string }> = {
  image: { attachment: 'foto', etiqueta: 'Imagen recibida' },
  sticker: { attachment: 'foto', etiqueta: 'Sticker recibido' },
  audio: { attachment: 'audio', etiqueta: 'Audio recibido' },
  voice: { attachment: 'audio', etiqueta: 'Nota de voz recibida' },
  video: { attachment: 'adjunto', etiqueta: 'Video recibido' },
  document: { attachment: 'adjunto', etiqueta: 'Archivo recibido' },
  file: { attachment: 'adjunto', etiqueta: 'Archivo recibido' },
  location: { attachment: 'ubicacion', etiqueta: 'Ubicación compartida' },
};

@Injectable()
export class WhatsappInboundService {
  private readonly logger = new Logger('WhatsAppInbound');
  /** IDs ya procesados: los proveedores reintentan. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly brain: BrainService,
    private readonly atencion: AtencionService,
    private readonly webhookLog: WebhookLogService,
    private readonly agente: ElevenLabsService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
  ) {}

  /** Punto de entrada único: detecta el formato y procesa. */
  async process(body: Record<string, unknown>, origen: 'gupshup' | 'whatsapp-cloud'): Promise<void> {
    const mensajes = this.esFormatoMeta(body)
      ? this.parseMeta(body, origen)
      : this.parseGupshup(body, origen);

    for (const m of mensajes) {
      if (this.yaVisto(m.id)) continue;

      const quien = m.profileName ?? m.from;
      const puerta = await this.hiloTomado(m.from);
      if (puerta.estado !== 'tomado') {
        /*
         * Nadie tomó el hilo. Antes eso era el final del camino y el mensaje
         * moría en la bitácora; ahora es el turno del agente — si está
         * configurado. Un hilo TOMADO no pasa por acá a propósito: lo atiende
         * una persona, y el agente encima sería una segunda voz contestando.
         */
        if (await this.atendioElAgente(m, origen)) continue;

        /*
         * Sin agente configurado se conserva el comportamiento de siempre, y
         * se dice CUÁL de las dos puertas lo frenó, porque se arreglan al
         * revés: "nadie lo tomó" lo resuelve el operador con un clic, y "no
         * conocemos el número" es un problema de emparejado de teléfonos que
         * hay que corregir en el código.
         */
        const motivo =
          puerta.estado === 'desconocido'
            ? `no hay ninguna conversación con ese número (${m.from})`
            : 'nadie tomó esa conversación todavía — el operador tiene que pulsar "Tomar"';
        this.logger.log(`← ${origen} de ${m.from}: "${m.text}" (solo bitácora: ${puerta.estado})`);
        this.webhookLog.push(origen, `Mensaje de ${quien}: “${m.text}” — no entra al Brain: ${motivo}`, true, {
          from: m.from,
          estado: puerta.estado,
        });
        continue;
      }
      const contactId = puerta.contactId;

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
        attachment: m.attachment,
        attachmentUrl: m.attachmentUrl,
      });
      const clase = m.attachment ? `[${m.attachment}] ` : '';
      this.logger.log(`← ${origen} de ${m.from}: ${clase}"${m.text}" → hilo tomado`);
      this.webhookLog.push(
        origen,
        `Respuesta de ${m.profileName ?? m.from} en un hilo tomado: ${clase}“${m.text}”`,
        true,
        { from: m.from },
      );
    }
  }

  /**
   * El agente contesta por nuestro canal. `true` si se hizo cargo.
   *
   * Acá es donde la voz deja de ser una isla: la conversación ocurre sobre
   * NUESTRO número de Gupshup, con el contexto del Brain, y queda en el mismo
   * hilo que el operador ve en la consola y puede tomar cuando quiera. Con NL
   * Pearl esto era imposible — el ciudadano estaba en su número y nosotros
   * mirábamos desde afuera.
   *
   * A diferencia de preguntar por un hilo, acá SÍ se da de alta al contacto si
   * no existía: no es un fantasma, es alguien con quien estamos conversando de
   * verdad. Ese es el primer mensaje de un hilo nuevo.
   */
  private async atendioElAgente(m: MensajeNormalizado, origen: 'gupshup' | 'whatsapp-cloud'): Promise<boolean> {
    if (!this.agente.configurado()) return false;

    try {
      const { contactId } = await this.brain.resolveIdentity({
        phone: m.from,
        displayName: m.profileName,
      });

      // El mensaje entra ANTES de responder: si el agente falla, igual queda
      // registrado lo que la persona dijo y un humano puede retomarlo.
      await this.brain.appendInteraction({
        contactId,
        channel: 'whatsapp',
        direction: 'inbound',
        occurredAt: new Date().toISOString(),
        summary: m.text,
        source: 'own',
        attachment: m.attachment,
        attachmentUrl: m.attachmentUrl,
      });

      const respuesta = await this.agente.responderEnHilo(contactId, m.text);
      if (!respuesta) {
        // El motor está encendido pero no contestó. No se inventa una
        // respuesta: queda el mensaje del ciudadano y el aviso para que un
        // humano lo vea en la consola.
        this.webhookLog.push(
          origen,
          `Mensaje de ${m.profileName ?? m.from}: “${m.text}” — el agente no contestó; queda para un humano`,
          false,
          { from: m.from },
        );
        return true;
      }

      const envio = await this.whatsapp.send(contactId, respuesta);
      await this.brain.appendInteraction({
        contactId,
        channel: 'whatsapp',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: respuesta,
        source: 'own',
        handledBy: 'agente',
        collectedInfo: envio.providerId ? { providerId: envio.providerId } : undefined,
      });

      this.logger.log(`← ${origen} de ${m.from}: "${m.text}" → el agente respondió`);
      this.webhookLog.push(
        origen,
        `El agente atendió a ${m.profileName ?? m.from}: “${m.text}” → “${respuesta}”`,
        true,
        { from: m.from },
      );
      return true;
    } catch (err) {
      // Que el agente falle no puede tumbar el webhook: se deja rastro y el
      // mensaje sigue el camino de siempre (bitácora).
      this.logger.warn(`El agente no pudo atender a ${m.from}: ${(err as Error).message}`);
      this.webhookLog.push(origen, `El agente falló atendiendo a ${m.from}: ${(err as Error).message}`, false);
      return false;
    }
  }

  /**
   * Si ese número puede escribir en un hilo, y si no, POR QUÉ no.
   *
   * `desconocido` = no hay conversación con ese número (nunca escribió, o no
   * estamos emparejando bien el teléfono). `sin-tomar` = la conversación
   * existe pero la sigue atendiendo el agente. Son causas distintas con
   * arreglos distintos, y por eso no comparten respuesta.
   */
  private async hiloTomado(
    telefono: string,
  ): Promise<{ estado: 'tomado'; contactId: string } | { estado: 'desconocido' | 'sin-tomar' }> {
    try {
      /*
       * `findAllByPhone` y no `findByPhone`: el mismo número puede tener más
       * de un contacto (duplicados que dejó el emparejado por texto exacto),
       * y el primero que devuelva la consulta no tiene por qué ser el que el
       * operador tomó. Gana el que esté tomado, venga en el orden que venga.
       *
       * Y ninguno de los dos crea: con `resolveIdentity`, preguntar por un
       * número desconocido dejaba un contacto fantasma en Conversaciones.
       */
      const contactos = await this.brain.findAllByPhone(telefono);
      if (!contactos.length) return { estado: 'desconocido' };

      for (const contacto of contactos) {
        const { operador } = await this.atencion.de(contacto.id);
        if (operador) return { estado: 'tomado', contactId: contacto.id };
      }
      return { estado: 'sin-tomar' };
    } catch (err) {
      this.logger.warn(`No se pudo resolver ${telefono}: ${(err as Error).message}`);
      return { estado: 'desconocido' };
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
          if (!from) continue;
          const desde = from.startsWith('+') ? from : `+${from}`;
          const id = String(msg['id'] ?? `${from}-${msg['timestamp']}`);

          if (texto) {
            salida.push({ id, from: desde, text: texto, profileName });
            continue;
          }

          // Sin texto: puede ser un archivo. Se reconoce por `type` y se surface
          // como adjunto en vez de tirarlo. Gupshup entrega una URL directa a su
          // filemanager; según el formato puede venir en `url`, `link` o `text`.
          const tipo = String(msg['type'] ?? '');
          const media = MEDIA[tipo];
          if (media) {
            const obj = (msg[tipo] as Record<string, unknown>) ?? {};
            const caption = (obj['caption'] as string)?.trim();
            salida.push({
              id,
              from: desde,
              text: caption || media.etiqueta,
              profileName,
              attachment: media.attachment,
              attachmentUrl: this.urlDeMedia(obj, origen, tipo),
            });
            continue;
          }

          this.logger.log(`Mensaje ${tipo} ignorado (tipo no reconocido)`);
          this.webhookLog.push(
            origen as 'gupshup',
            `Mensaje de tipo "${tipo || 'desconocido'}" no reconocido`,
            false,
            { from, msg },
          );
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
    if (tipo !== 'message') {
      this.webhookLog.push(origen as 'gupshup', `Evento "${String(tipo)}" ignorado: no es un mensaje`, true);
      return [];
    }

    const interno = (payload['payload'] as Record<string, unknown>) ?? {};
    const sender = (payload['sender'] as Record<string, unknown>) ?? {};
    const texto = (interno['text'] ?? interno['title'] ?? interno['postbackText']) as string | undefined;
    const phone = (sender['phone'] ?? payload['source']) as string | undefined;

    if (!phone) {
      this.webhookLog.push(origen as 'gupshup', 'Mensaje descartado: sin remitente', false, {
        tipo: payload['type'],
      });
      return [];
    }
    const desde = phone.startsWith('+') ? phone : `+${phone}`;
    const id = String(payload['id'] ?? `${phone}-${Date.now()}`);
    const nombre = sender['name'] as string | undefined;

    if (texto) {
      return [{ id, from: desde, text: texto, profileName: nombre }];
    }

    // Sin texto: en el formato v2 el tipo de media está en `payload.type` y el
    // archivo, con su URL, en `payload.payload` — Gupshup sí la entrega acá.
    const tipoMedia = String(payload['type'] ?? '');
    const media = MEDIA[tipoMedia];
    if (media) {
      const caption = (interno['caption'] as string)?.trim();
      return [
        {
          id,
          from: desde,
          text: caption || media.etiqueta,
          profileName: nombre,
          attachment: media.attachment,
          attachmentUrl: this.urlDeMedia(interno, origen, tipoMedia),
        },
      ];
    }

    this.webhookLog.push(origen as 'gupshup', `Mensaje de tipoMedia "${tipoMedia || 'desconocido'}" sin texto`, false, {
      payload,
    });
    return [];
  }

  /**
   * La URL del archivo, buscándola en las varias formas en que los proveedores
   * la ponen. Gupshup entrega una URL directa a su filemanager; según el
   * formato del callback puede venir en `url`, `link` o `text`.
   *
   * Si no aparece en ninguna, deja rastro del shape en la bitácora — con los
   * NOMBRES de los campos presentes— para poder apuntar al correcto sin
   * adivinar. Ese es el dato que dice si este proveedor nos da con qué
   * descargar o solo un id que no sirve por sí solo.
   */
  private urlDeMedia(obj: Record<string, unknown>, origen: string, tipo: string): string | undefined {
    const url = [obj['url'], obj['link'], obj['text']].find(
      (v) => typeof v === 'string' && /^https?:\/\//i.test(v),
    ) as string | undefined;
    if (url) return url;
    this.webhookLog.push(
      origen as 'gupshup',
      `Media "${tipo}" recibida sin URL directa — campos presentes: [${Object.keys(obj).join(', ')}]`,
      true,
      { media: obj },
    );
    return undefined;
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
