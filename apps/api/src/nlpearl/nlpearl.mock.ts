import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { NlpearlCallContext } from '../brain/types';
import { StartCallInput, VoiceEnginePort } from '../ports/voice-engine.port';
import { FlowLogService } from '../shared/flow-log.service';
import { NlpearlCallApiView } from './nlpearl.client';
import { toCallContext } from './nlpearl.mapper';

/**
 * Motor de voz simulado (MOCK=true). `startCall` emula el ciclo completo
 * de NL Pearl contra NUESTROS propios endpoints HTTP, tal como lo haría
 * el servicio real:
 *   1. ~0.5s después: POST /precall  (nodo PreCallAPI pide contexto)
 *   2. ~1.5s después: POST /webhooks/nlpearl (llamada finalizada)
 * Así el guard de firma, el controller y el pipeline del Brain se ejercitan
 * de verdad, no solo por llamadas internas.
 */
@Injectable()
export class NlpearlMockEngine implements VoiceEnginePort {
  private readonly logger = new Logger('NlpearlMock');
  private readonly baseUrl: string;
  private readonly webhookSecret: string;

  /** Llamadas simuladas "finalizadas", consultables como con getCall(callId). */
  private readonly calls = new Map<string, NlpearlCallApiView>();

  constructor(config: ConfigService, private readonly flowLog: FlowLogService) {
    this.baseUrl = `http://localhost:${config.get<number>('PORT', 3000)}`;
    this.webhookSecret = config.get<string>('NLPEARL_WEBHOOK_SECRET', '');
  }

  async startCall(input: StartCallInput): Promise<{ leadId: string }> {
    const leadId = `lead_${randomUUID().slice(0, 8)}`;
    const callId = `call_${randomUUID().slice(0, 8)}`;
    this.logger.log(`[mock] addLead → lead ${leadId} para ${input.phone} (externalId=${input.externalId})`);
    this.flowLog.push('addLead', `addLead (mock): lead ${leadId} creado, llamada saliente agendada`, {
      leadId,
      phone: input.phone,
      externalId: input.externalId,
    });

    // Ciclo asíncrono de la "llamada": precall → conversación → webhook.
    setTimeout(() => void this.simulateCallLifecycle(input, callId), 500);
    return { leadId };
  }

  async getCallContext(callId: string): Promise<NlpearlCallContext> {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`[mock] llamada ${callId} no existe`);
    return toCallContext(call);
  }

  /**
   * Simula una llamada ENTRANTE: un número (quizás desconocido) llama,
   * conversa unos segundos y al colgar se emite el mismo webhook de
   * llamada finalizada. Devuelve cuando el webhook ya fue entregado.
   */
  async simulateInboundCall(phone: string): Promise<{ callId: string }> {
    const callId = `call_in_${randomUUID().slice(0, 8)}`;
    this.logger.log(`[mock] llamada entrante de ${phone} → ${callId}`);

    // "Conversación" entrante (~4s) para que se aprecie en la consola.
    await new Promise((r) => setTimeout(r, 4000));

    this.calls.set(callId, {
      id: callId,
      pearlId: 'pearl_mock',
      startTime: new Date(Date.now() - 75_000).toISOString(),
      status: 4,
      conversationStatus: 100,
      direction: 'inbound',
      from: phone, // entrante: "from" es el cliente
      to: '+50577770000',
      duration: 75,
      recording: `https://recordings.mock.nlpearl.ai/${callId}.mp3`,
      transcript: [
        { role: 'user', content: 'Buenas, llamo porque me llegó un mensaje sobre un saldo pendiente. Quisiera ver opciones.' },
        { role: 'assistant', content: '¡Con gusto le ayudo! ¿Con quién tengo el gusto?' },
        { role: 'user', content: 'Pedro Ramírez.' },
        { role: 'assistant', content: 'Gracias, Pedro. Veo un saldo de 2350. ¿Le envío las opciones de pago por WhatsApp?' },
        { role: 'user', content: 'Sí, perfecto, por WhatsApp está bien.' },
      ],
      summary:
        'Llamada entrante: Pedro Ramírez consultó su saldo pendiente (2350) y pidió recibir las opciones de pago por WhatsApp.',
      collectedInfo: [
        { id: 'ci_1', name: 'contactName', value: 'Pedro Ramírez' },
        { id: 'ci_2', name: 'preferredChannel', value: 'whatsapp' },
        { id: 'ci_3', name: 'consultReason', value: 'saldo_pendiente' },
      ],
      tags: ['consulta_saldo'],
      overallSentiment: 4,
    });

    // Webhook de llamada finalizada hacia nuestro gateway (mismo flujo que outbound).
    const body = JSON.stringify({ event: 'call.finished', callId, pearlId: 'pearl_mock' });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.webhookSecret) headers['authorization'] = `Bearer ${this.webhookSecret}`;
    await fetch(`${this.baseUrl}/webhooks/nlpearl`, { method: 'POST', headers, body });
    return { callId };
  }

  private async simulateCallLifecycle(input: StartCallInput, callId: string): Promise<void> {
    try {
      // 1) Nodo PreCallAPI: pide contexto a nuestro gateway antes de hablar.
      const precallRes = await fetch(`${this.baseUrl}/precall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: input.phone, externalId: input.externalId }),
      });
      const variables = (await precallRes.json()) as Record<string, string>;
      this.logger.log(`[mock] precall respondió: ${JSON.stringify(variables)}`);

      // 2) "Conversación" simulada usando el contexto inyectado (~6s para que
      //    el avatar de voz en vivo se aprecie en la consola).
      await new Promise((r) => setTimeout(r, 6000));
      const call = this.buildFinishedCall(input, callId, variables);
      this.calls.set(callId, call);

      // 3) Webhook de llamada finalizada hacia nuestro gateway. Como NL Pearl
      //    real: si hay credential configurado, viaja en cada entrega.
      const body = JSON.stringify({ event: 'call.finished', callId, pearlId: 'pearl_mock' });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.webhookSecret) headers['authorization'] = `Bearer ${this.webhookSecret}`;
      await fetch(`${this.baseUrl}/webhooks/nlpearl`, { method: 'POST', headers, body });
    } catch (err) {
      this.logger.error(`[mock] ciclo de llamada falló: ${(err as Error).message}`);
      this.flowLog.push('error', `Error en llamada simulada: ${(err as Error).message}`);
      this.flowLog.finish();
    }
  }

  /** Payload de llamada finalizada con la forma CallApiView de v2. */
  private buildFinishedCall(
    input: StartCallInput,
    callId: string,
    variables: Record<string, string>,
  ): NlpearlCallApiView {
    const name = variables['contactName'] ?? 'cliente';
    const inSevenDays = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return {
      id: callId,
      pearlId: 'pearl_mock',
      startTime: new Date(Date.now() - 95_000).toISOString(),
      status: 4, // Completed
      conversationStatus: 100, // Success
      from: '+50577770000',
      to: input.phone,
      duration: 95,
      recording: `https://recordings.mock.nlpearl.ai/${callId}.mp3`,
      externalId: input.externalId,
      transcript: [
        { role: 'assistant', content: `Buenas, ¿hablo con ${name}? Le llamamos por su cuenta pendiente.` },
        { role: 'user', content: 'Sí, con ella. Fíjese que ando un poco corta este mes.' },
        {
          role: 'assistant',
          content: `Entiendo. Veo que tiene una promesa previa. ¿Puede comprometerse a pagar 1500 antes del ${inSevenDays}?`,
        },
        { role: 'user', content: 'Sí, para esa fecha sí puedo. Me comprometo a los 1500.' },
        { role: 'assistant', content: 'Perfecto, queda registrado. Le enviaremos la confirmación por WhatsApp. ¡Gracias!' },
      ],
      summary: `Cliente confirmó promesa de pago por 1500 antes del ${inSevenDays}. Actitud cooperativa; pidió recordatorio por WhatsApp.`,
      collectedInfo: [
        { id: 'ci_1', name: 'promiseAmount', value: 1500 },
        { id: 'ci_2', name: 'promiseDate', value: inSevenDays },
        { id: 'ci_3', name: 'preferredChannel', value: 'whatsapp' },
      ],
      tags: ['promesa_de_pago'],
      overallSentiment: 4, // positivo
    };
  }
}
