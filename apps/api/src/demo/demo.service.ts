import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRAIN_REPOSITORY, BrainRepository } from '../brain/brain.repository';
import { BrainService } from '../brain/brain.service';
import { VOICE_ENGINE_PORT, VoiceEnginePort } from '../ports/voice-engine.port';
import { FlowLogService } from '../shared/flow-log.service';

/**
 * Orquesta el flujo demo end-to-end (modo mock):
 * sembrado → addLead → precall → llamada → webhook → Brain → WhatsApp.
 * Los pasos precall/webhook/brain/followup los reportan los propios
 * controllers/servicios vía FlowLogService; acá solo se siembra y dispara.
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  private readonly baseUrl: string;

  constructor(
    private readonly brain: BrainService,
    @Inject(BRAIN_REPOSITORY) private readonly repo: BrainRepository,
    @Inject(VOICE_ENGINE_PORT) private readonly voice: VoiceEnginePort,
    private readonly flowLog: FlowLogService,
    config: ConfigService,
  ) {
    this.baseUrl = `http://localhost:${config.get<number>('PORT', 3000)}`;
  }

  status() {
    return this.flowLog.snapshot();
  }

  /** Dispara una llamada para un contacto existente (botón "Llamar (demo)"). */
  async triggerCall(contactId: string): Promise<{ leadId: string }> {
    const ctx = await this.brain.getContext({ contactId });
    const phone = ctx.contact.phones[0];
    if (!phone) throw new Error(`El contacto ${contactId} no tiene teléfono`);
    // externalId = nuestro contactId: la llave de unión con NL Pearl.
    return this.voice.startCall({ phone, externalId: contactId });
  }

  /** Flujo completo desde cero, con datos sembrados. */
  async run(): Promise<{ contactId: string }> {
    this.flowLog.start();

    // 1) Sembrar contacto con promesa activa + interacción previa de WhatsApp.
    await this.repo.reset();
    const contact = await this.brain.upsertContact({
      displayName: 'María López',
      phones: ['+50588887777'],
      externalIds: { sender: 'snd_84421' },
      kycmStatus: 'verified',
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    await this.brain.appendInteraction({
      contactId: contact.id,
      channel: 'whatsapp',
      direction: 'inbound',
      occurredAt: twoDaysAgo,
      summary: 'Cliente preguntó por su saldo pendiente y pidió que la llamaran para coordinar el pago.',
      sentiment: 'neutral',
      source: 'own',
    });
    await this.brain.setSignal({
      contactId: contact.id,
      type: 'promise',
      amount: 1500,
      dueDate: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: 'active',
      text: 'Promesa acordada por WhatsApp',
    });
    // Contactos extra para que el directorio muestre variedad (filtros/estados).
    const carlos = await this.brain.upsertContact({
      displayName: 'Carlos Mendoza',
      phones: ['+50577665544'],
      kycmStatus: 'unverified',
    });
    await this.brain.appendInteraction({
      contactId: carlos.id,
      channel: 'voice',
      direction: 'outbound',
      occurredAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      summary: 'No contestó; se dejó mensaje en buzón de voz.',
      sentiment: 'negative',
      source: 'nlpearl',
    });
    await this.brain.setSignal({
      contactId: carlos.id,
      type: 'flag',
      status: 'active',
      text: 'Difícil de contactar por voz; intentar por SMS',
    });

    const ana = await this.brain.upsertContact({
      displayName: 'Ana Chavarría',
      phones: ['+50581234567'],
      kycmStatus: 'verified',
    });
    await this.brain.appendInteraction({
      contactId: ana.id,
      channel: 'sms',
      direction: 'inbound',
      occurredAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      summary: 'Consultó cómo actualizar su método de pago.',
      sentiment: 'positive',
      source: 'own',
    });

    this.flowLog.push('seed', 'Contactos sembrados: María López (promesa activa), Carlos Mendoza y Ana Chavarría', {
      contactId: contact.id,
    });
    this.logger.log(`Demo: contacto sembrado ${contact.id}`);

    // 2) addLead → el resto del flujo lo emite el motor (mock) hacia
    //    /precall y /webhooks/nlpearl, y cada pieza reporta su paso.
    await this.triggerCall(contact.id);

    return { contactId: contact.id };
  }

  /**
   * Práctica ENTRANTE: llamada entrante de un número (quizás nuevo) →
   * el Brain guarda el contexto → luego el mismo número escribe por
   * WhatsApp → identidad reconocida + respuesta automática con contexto.
   */
  async runInbound(): Promise<{ phone: string }> {
    if (!this.voice.simulateInboundCall) {
      throw new BadRequestException('La práctica entrante solo corre en modo MOCK');
    }
    this.flowLog.start();
    const phone = '+50570009999';
    this.flowLog.push('inboundCall', `Llamada entrante desde ${phone} — el Brain resolverá la identidad por teléfono`);

    // Orquestación en background: la consola sigue el paso a paso por polling.
    void this.orchestrateInbound(phone);
    return { phone };
  }

  private async orchestrateInbound(phone: string): Promise<void> {
    try {
      // 1) Llamada entrante simulada: conversa ~4s y emite el webhook →
      //    recordCallContext crea/enriquece el contacto y guarda el contexto.
      await this.voice.simulateInboundCall!(phone);

      // 2) Un rato después, el cliente escribe por WhatsApp al mismo número.
      //    Entra por el webhook de canales propios (self-HTTP, como en real).
      await new Promise((r) => setTimeout(r, 2500));
      await fetch(`${this.baseUrl}/webhooks/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'whatsapp',
          from: phone,
          text: 'Hola, les escribo por lo que hablamos en la llamada de hace un rato. ¿Me pasan las opciones?',
        }),
      });
    } catch (err) {
      this.logger.error(`Práctica entrante falló: ${(err as Error).message}`);
      this.flowLog.push('error', `Error en la práctica entrante: ${(err as Error).message}`);
    } finally {
      this.flowLog.finish();
    }
  }
}
