import { Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { NlpearlCallContext } from '../brain/types';
import { FollowupService } from '../channels/followup.service';
import { FlowLogService } from '../shared/flow-log.service';

/**
 * Ingesta del contexto de una llamada finalizada: lo guarda en el Brain y
 * dispara el seguimiento por el canal configurado.
 *
 * Recibe la llamada ya normalizada (no el callId) para no depender del puerto
 * de voz: así el motor mock puede usar este mismo servicio sin ciclo de
 * dependencias, y el webhook HTTP hace exactamente lo mismo.
 */
@Injectable()
export class CallIngestService {
  private readonly logger = new Logger(CallIngestService.name);

  constructor(
    private readonly brain: BrainService,
    private readonly followup: FollowupService,
    private readonly flowLog: FlowLogService,
  ) {}

  async ingest(call: NlpearlCallContext): Promise<{ contactId: string }> {
    const interaction = await this.brain.recordCallContext(call);
    this.flowLog.push('brain', 'Brain actualizado: interacción de voz + señales guardadas', {
      contactId: interaction.contactId,
      summary: interaction.summary,
      sentiment: interaction.sentiment,
    });

    // Seguimiento cross-channel inmediato (WhatsApp/SMS propio, no NL Pearl).
    await this.followup.sendFollowup(interaction.contactId);
    this.flowLog.finish();
    this.logger.log(`Llamada ${call.callId} ingerida para el contacto ${interaction.contactId}`);
    return { contactId: interaction.contactId };
  }
}
