import { BadRequestException, Body, Controller, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { VOICE_ENGINE_PORT, VoiceEnginePort } from '../ports/voice-engine.port';
import { FlowLogService } from '../shared/flow-log.service';
import { CallIngestService } from './call-ingest.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';

/**
 * POST /webhooks/nlpearl — evento de llamada finalizada.
 * Flujo: webhook → getCall (contexto completo) → CallIngestService
 * (Brain + seguimiento por FOLLOWUP_CHANNEL).
 * // TODO: confirmar shape real del webhook con NL Pearl (acá: {event, callId, pearlId})
 */
const webhookSchema = z.object({
  event: z.string().optional(),
  callId: z.string(),
  pearlId: z.string().optional(),
});

@Controller('webhooks')
export class NlpearlWebhookController {
  private readonly logger = new Logger(NlpearlWebhookController.name);

  constructor(
    @Inject(VOICE_ENGINE_PORT) private readonly voice: VoiceEnginePort,
    private readonly ingest: CallIngestService,
    private readonly flowLog: FlowLogService,
  ) {}

  @Post('nlpearl')
  @UseGuards(WebhookSignatureGuard)
  async onCallFinished(@Body() body: unknown) {
    const parsed = webhookSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId } = parsed.data;

    this.logger.log(`Webhook: llamada ${callId} finalizada; recuperando contexto…`);
    this.flowLog.push('webhook', `Webhook recibido: llamada ${callId} finalizada`);

    // Con el webhook solo llega el aviso; el contexto completo se pide al motor
    // (equivale a getCall / getCallsBulk con fields en el modo real).
    const callContext = await this.voice.getCallContext(callId);
    const { contactId } = await this.ingest.ingest(callContext);

    return { received: true, contactId };
  }
}
