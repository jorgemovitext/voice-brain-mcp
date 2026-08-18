import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { PrecallService } from './precall.service';

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
  constructor(private readonly precall: PrecallService) {}

  @Post()
  precallVariables(@Body() body: unknown): Promise<Record<string, string>> {
    const parsed = precallSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { phoneNumber, phone, externalId } = parsed.data;
    return this.precall.buildVariables({ phone: phoneNumber ?? phone, externalId });
  }
}
