import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { WebhookLogService } from '../shared/webhook-log.service';
import { CallIngestService } from './call-ingest.service';
import { NlpearlClient } from './nlpearl.client';

const simulateCallSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Teléfono en formato E.164, por ejemplo +50497616546'),
  displayName: z.string().trim().max(120).optional(),
  direction: z.enum(['inbound', 'outbound']).default('outbound'),
  /** Si se omite, se usa una conversación de ejemplo con promesa de pago. */
  transcript: z.string().optional(),
  summary: z.string().optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).default('positive'),
});

/**
 * Diagnóstico de la integración de voz. Vive en NlpearlModule porque usa
 * CallIngestService: llevarlo a IntegrationsModule crearía un ciclo
 * (Integrations ← Channels ← Nlpearl).
 */
@Controller('api/integrations/nlpearl')
export class NlpearlDiagnosticsController {
  constructor(
    private readonly client: NlpearlClient,
    private readonly ingest: CallIngestService,
    private readonly webhookLog: WebhookLogService,
  ) {}

  /**
   * Números de la cuenta y configuración del Pearl en uso: desde qué número
   * saldría la llamada y qué cobertura hay. Son lecturas, no cuestan.
   * Se prueban varios paths porque la doc pública no los fija.
   */
  @Get('phones')
  async phones() {
    this.client.assertConfigured();
    const candidatos = [
      '/v2/PearlSettings/Phones',
      '/v2/PearlSettings/GetPhones',
      '/v2/Account/Phones',
      '/v2/Account/PhoneNumbers',
      `/v2/Pearl/${this.client.pearlId}/Phones`,
    ];

    const intentos = await Promise.all(candidatos.map((p) => this.client.probe(p)));
    const encontrado = intentos.find((r) => r.status >= 200 && r.status < 300);
    const pearl = await this.client.probe(`/v2/Pearl/${this.client.pearlId}`);

    return {
      numeros: encontrado ? { path: encontrado.path, data: encontrado.data } : null,
      intentos: intentos.map(({ path, status }) => ({ path, status })),
      pearlEnUso: pearl.status >= 200 && pearl.status < 300 ? pearl.data : { status: pearl.status },
    };
  }

  /**
   * Inyecta una llamada YA FINALIZADA en el pipeline del Brain, sin marcar a
   * nadie: hace lo mismo que el webhook de NL Pearl (guarda transcripción,
   * resumen, sentimiento y señales, y dispara el seguimiento).
   *
   * Sirve para validar el flujo end-to-end cuando el país del destino no está
   * habilitado para llamar, o para no gastar créditos.
   */
  @Post('simulate-call')
  async simulateCall(@Body() body: unknown) {
    const parsed = simulateCallSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { phone, displayName, direction, sentiment } = parsed.data;

    const enSieteDias = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const transcript =
      parsed.data.transcript ??
      [
        `Agente: Buenas, ¿hablo con ${displayName ?? 'usted'}? Le llamo de Movitext.`,
        'Cliente: Sí, con él. Cuénteme.',
        `Agente: ¿Puede comprometerse a pagar 1500 antes del ${enSieteDias}?`,
        'Cliente: Sí, para esa fecha puedo. Me comprometo.',
        'Agente: Perfecto, le enviamos la confirmación por WhatsApp.',
      ].join('\n');

    const { contactId } = await this.ingest.ingest({
      callId: `sim_${Date.now().toString(36)}`,
      phoneNumber: phone,
      direction,
      startedAt: new Date(Date.now() - 90_000).toISOString(),
      endedAt: new Date().toISOString(),
      transcript,
      summary:
        parsed.data.summary ??
        `Llamada simulada: el cliente confirmó una promesa de pago por 1500 antes del ${enSieteDias}.`,
      sentiment,
      collectedInfo: { contactName: displayName, promiseAmount: 1500, promiseDate: enSieteDias },
    });

    this.webhookLog.push('nlpearl', `Llamada simulada inyectada para ${phone}`, true, { contactId });
    return { ok: true, contactId, nota: 'No se marcó ningún teléfono: solo se alimentó el Brain.' };
  }
}
