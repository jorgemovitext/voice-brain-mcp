import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { BrainService } from '../brain/brain.service';
import { FlowLogService } from '../shared/flow-log.service';

/**
 * POST /precall — lo invoca el nodo PreCallAPI del flujo NL Pearl antes de
 * que el agente hable. Devuelve variables planas para que el agente NO
 * arranque en frío: nombre, promesa activa, saldo, último resumen.
 * // TODO: confirmar shape real del request/response PreCallAPI con NL Pearl
 */
const precallSchema = z
  .object({
    phoneNumber: z.string().optional(),
    phone: z.string().optional(), // alias tolerante
    externalId: z.string().optional(),
  })
  .refine((v) => v.phoneNumber || v.phone || v.externalId, {
    message: 'Se requiere phoneNumber o externalId',
  });

@Controller('precall')
export class PrecallController {
  constructor(private readonly brain: BrainService, private readonly flowLog: FlowLogService) {}

  @Post()
  async precall(@Body() body: unknown): Promise<Record<string, string>> {
    const parsed = precallSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { phoneNumber, phone, externalId } = parsed.data;

    const ctx = await this.brain.getContext({ phone: phoneNumber ?? phone, externalId });
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
