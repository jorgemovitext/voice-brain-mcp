import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { ChannelPort, SMS_CHANNEL, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { FlowLogService } from '../shared/flow-log.service';

/**
 * Seguimiento cross-channel: tras una llamada (o a demanda desde la consola)
 * genera el texto con brain_suggest_followup y lo envía por el canal
 * configurado (FOLLOWUP_CHANNEL). El envío queda registrado en el Brain
 * como interacción outbound del canal — mismo hilo, misma identidad.
 */
@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);
  private readonly defaultChannel: 'whatsapp' | 'sms';

  constructor(
    private readonly brain: BrainService,
    private readonly flowLog: FlowLogService,
    config: ConfigService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
    @Inject(SMS_CHANNEL) private readonly sms: ChannelPort,
  ) {
    this.defaultChannel = config.get<'whatsapp' | 'sms'>('FOLLOWUP_CHANNEL', 'whatsapp');
  }

  async sendFollowup(contactId: string, channel?: 'whatsapp' | 'sms'): Promise<{ message: string; channel: string }> {
    const target = channel ?? this.defaultChannel;
    const port = target === 'sms' ? this.sms : this.whatsapp;

    const message = await this.brain.suggestFollowup(contactId, target);
    const result = await port.send(contactId, message);

    // El seguimiento también es parte del contexto unificado.
    await this.brain.appendInteraction({
      contactId,
      channel: target,
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: message,
      source: 'own',
      collectedInfo: { providerId: result.providerId },
    });

    this.logger.log(`Seguimiento por ${target} enviado a ${contactId}`);
    this.flowLog.push('followup', `Seguimiento por ${target} enviado con el contexto actualizado`, { message });
    return { message, channel: target };
  }

  /**
   * Mensaje ENTRANTE de un cliente por WhatsApp/SMS (webhook del proveedor).
   * La gracia del Brain: se resuelve la identidad por teléfono y el hilo
   * continúa con TODO el contexto (incluida la última llamada de voz),
   * y se responde automáticamente usando ese contexto.
   */
  async receiveInbound(
    channel: 'whatsapp' | 'sms',
    from: string,
    text: string,
  ): Promise<{ contactId: string; reply: string }> {
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    this.flowLog.push('inboundMsg', `${label} entrante de ${from}: “${text}”`);

    // Misma llave de identidad que usa la voz: el teléfono E.164.
    const { contactId, created } = await this.brain.resolveIdentity({ phone: from, system: 'sender' });
    const ctx = await this.brain.getContext({ contactId });
    this.flowLog.push(
      'contextHit',
      created
        ? 'Número sin historial: se creó contacto nuevo'
        : `Identidad reconocida: ${ctx.contact.displayName ?? contactId} — contexto con ${ctx.recentInteractions.length} interacciones (incluida la llamada de voz)`,
      { contactId, interactions: ctx.recentInteractions.length },
    );

    await this.brain.appendInteraction({
      contactId,
      channel,
      direction: 'inbound',
      occurredAt: new Date().toISOString(),
      summary: text,
      source: 'own',
    });

    // Respuesta automática construida desde el contexto del hilo.
    const reply = await this.brain.suggestFollowup(contactId, channel);
    const port = channel === 'sms' ? this.sms : this.whatsapp;
    const result = await port.send(contactId, reply);
    await this.brain.appendInteraction({
      contactId,
      channel,
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: reply,
      source: 'own',
      collectedInfo: { providerId: result.providerId, auto: true },
    });
    this.flowLog.push('autoReply', 'Respuesta automática enviada usando el contexto del hilo', { reply });

    return { contactId, reply };
  }

  /**
   * Mensaje libre escrito por el operador desde la consola (composer del
   * chat). Sale por el canal indicado y queda en el mismo hilo del Brain.
   */
  async sendMessage(
    contactId: string,
    text: string,
    channel?: 'whatsapp' | 'sms',
  ): Promise<{ message: string; channel: string }> {
    const target = channel ?? this.defaultChannel;
    const port = target === 'sms' ? this.sms : this.whatsapp;
    const result = await port.send(contactId, text);

    await this.brain.appendInteraction({
      contactId,
      channel: target,
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: text,
      source: 'own',
      collectedInfo: { providerId: result.providerId },
    });
    return { message: text, channel: target };
  }
}
