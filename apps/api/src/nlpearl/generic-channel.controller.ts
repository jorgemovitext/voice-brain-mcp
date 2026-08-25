import { Body, Controller, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { BrainService } from '../brain/brain.service';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { WebhookLogService } from '../shared/webhook-log.service';
import { GenericChannelGuard } from './generic-channel.guard';

/**
 * Canal Generic de NL Pearl: mensajes en vivo, uno por uno.
 *
 * Es el ÚNICO camino documentado para tener la conversación de texto en
 * tiempo real. Los canales nativos (WhatsApp, Telegram, SMS) solo disparan un
 * webhook al abrir y otro al cerrar el chat, y los endpoints de Calls no
 * devuelven nada para esta cuenta —comprobado contra la API con un rango de
 * dos años sobre las 23 Pearls: `{"count":0}`—, así que tampoco se puede
 * sondear. Con el canal Generic, NL Pearl empuja CADA mensaje del agente.
 *
 * A cambio, la entrega la hacemos nosotros: NL Pearl deja de hablarle al
 * ciudadano y nos manda el texto para que salga por nuestro WhatsApp
 * (Gupshup). El sentido contrario —lo que escribe el ciudadano— entra por
 * `/webhooks/gupshup` y se reenvía a NL Pearl desde `WhatsappInboundService`.
 *
 * Formato del sobre, fijado por la documentación:
 *   { type, channelId, chatId, timestamp, data }
 * donde `chatId` es el teléfono y `type` ∈ message | typing | handoff |
 * ai_resumed | conversation_ended.
 */
@Public()
@Controller('webhooks/nlpearl')
export class GenericChannelController {
  private readonly logger = new Logger(GenericChannelController.name);

  constructor(
    private readonly brain: BrainService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
    private readonly webhookLog: WebhookLogService,
  ) {}

  @Post('mensaje')
  @UseGuards(GenericChannelGuard)
  async onEvento(@Body() body: unknown) {
    const e = (body ?? {}) as {
      type?: string;
      chatId?: string;
      timestamp?: string;
      data?: { messageId?: string; text?: string; reason?: string };
    };

    const telefono = (e.chatId ?? '').trim();
    if (!telefono) {
      this.webhookLog.push('nlpearl', 'Evento del canal sin chatId', false, e);
      return { received: true, procesado: false, motivo: 'Falta chatId' };
    }

    const { contactId } = await this.brain.resolveIdentity({ phone: telefono, system: 'sender' });
    const cuando = e.timestamp && !Number.isNaN(Date.parse(e.timestamp))
      ? new Date(e.timestamp).toISOString()
      : new Date().toISOString();

    switch (e.type) {
      case 'message':
        return this.mensajeDelAgente(contactId, telefono, e.data?.text ?? '', e.data?.messageId, cuando);

      case 'handoff':
        // Que el agente pida un humano es información del hilo, no ruido.
        await this.brain.setSignal({
          contactId,
          type: 'flag',
          status: 'active',
          text: `El agente pidió pasar a un operador (${e.data?.reason ?? 'sin motivo'})`,
        });
        this.webhookLog.push('nlpearl', `Pide operador · ${telefono}`, true, e);
        return { received: true, tipo: 'handoff' };

      case 'conversation_ended':
        this.webhookLog.push('nlpearl', `Conversación cerrada · ${telefono}`, true, e);
        return { received: true, tipo: 'conversation_ended' };

      // `typing` y `ai_resumed` no cambian el hilo: se acusan y ya.
      default:
        return { received: true, tipo: e.type ?? 'desconocido' };
    }
  }

  /**
   * Un mensaje del agente: primero se guarda —para que aparezca en la consola
   * aunque la entrega falle— y después se entrega al ciudadano.
   */
  private async mensajeDelAgente(
    contactId: string,
    telefono: string,
    texto: string,
    messageId: string | undefined,
    cuando: string,
  ) {
    if (!texto.trim()) return { received: true, procesado: false, motivo: 'Mensaje vacío' };

    await this.brain.appendInteraction({
      // Id determinista: NL Pearl puede reintentar el mismo evento y no
      // queremos el mensaje dos veces en el hilo.
      id: messageId ? `generic:${messageId}` : undefined,
      contactId,
      channel: 'whatsapp',
      direction: 'outbound',
      occurredAt: cuando,
      summary: texto,
      source: 'nlpearl',
    });

    let entregado = false;
    let motivo: string | undefined;
    try {
      // Por el puerto, no por Gupshup directo: así respeta el proveedor
      // configurado (Gupshup, Cloud API o el stub) sin tocar este archivo.
      await this.whatsapp.send(contactId, texto);
      entregado = true;
    } catch (err) {
      motivo = (err as Error).message;
      this.logger.warn(`No se pudo entregar el mensaje a ${telefono}: ${motivo}`);
    }

    this.webhookLog.push(
      'nlpearl',
      entregado ? `Mensaje del agente → ${telefono}` : `Mensaje del agente NO entregado a ${telefono}: ${motivo}`,
      entregado,
      { telefono, messageId },
    );
    return { received: true, entregado, motivo };
  }
}
