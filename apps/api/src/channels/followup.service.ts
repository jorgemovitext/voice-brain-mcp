import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { Interaction } from '../brain/types';
import type { GupshupAdapter } from '../integrations/whatsapp/gupshup.adapter';
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
  private readonly autoReplyMode: 'first' | 'always' | 'off';
  private readonly autoReplyCooldownH: number;

  constructor(
    private readonly brain: BrainService,
    private readonly flowLog: FlowLogService,
    config: ConfigService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
    @Inject(SMS_CHANNEL) private readonly sms: ChannelPort,
  ) {
    this.defaultChannel = config.get<'whatsapp' | 'sms'>('FOLLOWUP_CHANNEL', 'whatsapp');
    this.autoReplyMode = config.get<'first' | 'always' | 'off'>('AUTO_REPLY_MODE', 'first');
    this.autoReplyCooldownH = config.get<number>('AUTO_REPLY_COOLDOWN_HOURS', 12);
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
    /** Nombre del perfil, cuando el proveedor lo manda (WhatsApp lo incluye). */
    profileName?: string,
  ): Promise<{ contactId: string; reply: string }> {
    const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
    this.flowLog.push('inboundMsg', `${label} entrante de ${from}: “${text}”`);

    // Misma llave de identidad que usa la voz: el teléfono E.164.
    const { contactId, created } = await this.brain.resolveIdentity({
      phone: from,
      system: 'sender',
      displayName: profileName,
    });

    // Un contacto que llegó por voz puede no tener nombre todavía.
    if (profileName) {
      const known = await this.brain.getContext({ contactId });
      if (!known.contact.displayName) {
        await this.brain.upsertContact({ id: contactId, displayName: profileName });
      }
    }

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

    if (!this.debeAutoResponder(ctx.recentInteractions)) {
      this.flowLog.push('inboundMsg', 'Mensaje registrado sin auto-respuesta (ya hay conversación abierta)');
      return { contactId, reply: '' };
    }

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
   * Evita el saludo automático en cada mensaje: repetir siempre el mismo texto
   * es molesto y hace ruido en el hilo.
   *
   * `first` (default): solo si no hubo una respuesta automática reciente, o sea
   * al abrir la conversación y tras un silencio largo. `always` mantiene el
   * comportamiento anterior; `off` no responde nunca (el operador contesta).
   */
  private debeAutoResponder(previas: Interaction[]): boolean {
    if (this.autoReplyMode === 'off') return false;
    if (this.autoReplyMode === 'always') return true;

    const limite = Date.now() - this.autoReplyCooldownH * 3600 * 1000;
    const respuestaReciente = previas.some(
      (i) =>
        i.direction === 'outbound' &&
        (i.collectedInfo as { auto?: boolean } | undefined)?.auto === true &&
        new Date(i.occurredAt).getTime() >= limite,
    );
    return !respuestaReciente;
  }

  /**
   * Mensaje libre escrito por el operador desde la consola (composer del
   * chat). Sale por el canal indicado y queda en el mismo hilo del Brain.
   */
  async sendMessage(
    contactId: string,
    text: string,
    channel?: 'whatsapp' | 'sms',
    /** Nombre real del operador, para la plantilla de apertura. */
    operador?: string,
  ): Promise<{ message: string; channel: string; abrioConPlantilla?: boolean }> {
    const target = channel ?? this.defaultChannel;
    const port = target === 'sms' ? this.sms : this.whatsapp;

    let abrioConPlantilla = false;
    let result: { delivered: boolean; providerId?: string };
    try {
      result = await port.send(contactId, text);
    } catch (err) {
      /*
       * Ventana de 24 h cerrada: el ciudadano le escribió al número de NL
       * Pearl, no al nuestro, así que WhatsApp no deja texto libre. Se abre
       * con la plantilla aprobada —que sí puede iniciar— y el operador
       * reenvía su mensaje cuando el ciudadano conteste.
       */
      const plantilla = await this.abrirConPlantilla(contactId, target, err, operador);
      if (!plantilla) throw err;
      result = plantilla;
      abrioConPlantilla = true;
    }

    await this.brain.appendInteraction({
      contactId,
      channel: target,
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: text,
      source: 'own',
      collectedInfo: { providerId: result.providerId },
    });
    return { message: text, channel: target, abrioConPlantilla };
  }

  /**
   * Intenta abrir la conversación con la plantilla de saludo. Devuelve null
   * si no aplica —otro error, otro canal, o sin plantilla configurada— para
   * que el llamador propague el fallo original en vez de enmascararlo.
   */
  private async abrirConPlantilla(
    contactId: string,
    target: 'whatsapp' | 'sms',
    err: unknown,
    operador?: string,
  ): Promise<{ delivered: boolean; providerId?: string } | null> {
    const gupshup = this.whatsapp as Partial<GupshupAdapter>;
    const esVentana = /sesión abierta|session|24|window|opt.?in/i.test((err as Error).message ?? '');
    if (target !== 'whatsapp' || !esVentana) return null;
    if (typeof gupshup.sendTemplate !== 'function' || !gupshup.templateSaludo) return null;

    const ctx = await this.brain.getContext({ contactId });
    const to = ctx.contact.phones[0];
    if (!to) return null;

    const nombre = ctx.contact.displayName?.trim().split(/\s+/)[0] ?? 'buenas';
    return gupshup.sendTemplate(to, gupshup.templateSaludo, [
      nombre,
      operador?.trim() || 'un operador de la AMDC',
    ]);
  }
}
