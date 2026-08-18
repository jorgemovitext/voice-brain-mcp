import { Injectable } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { FlowLogService } from '../shared/flow-log.service';

/**
 * Variables que el nodo PreCallAPI inyecta al agente antes de hablar, para
 * que no arranque en frío. Vive en un servicio (no en el controller) porque
 * el motor mock también las consume sin pasar por HTTP.
 */
@Injectable()
export class PrecallService {
  constructor(private readonly brain: BrainService, private readonly flowLog: FlowLogService) {}

  async buildVariables(query: { phone?: string; externalId?: string }): Promise<Record<string, string>> {
    const ctx = await this.brain.getContext({ phone: query.phone, externalId: query.externalId });
    const promise = ctx.signals.find((s) => s.type === 'promise' && s.status === 'active');
    const lastInteraction = ctx.recentInteractions[0];

    // Variables planas (string) para el flujo de voz.
    const variables: Record<string, string> = {
      contactName: ctx.contact.displayName ?? '',
      kycmStatus: ctx.contact.kycmStatus ?? 'unverified',
      activePromiseAmount: promise?.amount?.toString() ?? '',
      activePromiseDue: promise?.dueDate ?? '',
      balance: '2350.00', // TODO: conectar al core bancario/CRM real
      lastSummary: lastInteraction?.summary ?? '',
      lastChannel: lastInteraction?.channel ?? '',
    };

    this.flowLog.push('precall', 'PreCallAPI: contexto inyectado al agente de voz', variables);
    return variables;
  }
}
