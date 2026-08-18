import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { FollowupService } from './followup.service';

/**
 * POST /webhooks/channels — webhook de mensajes entrantes de NUESTROS
 * canales (WABA propia / proveedor SMS), no de NL Pearl.
 * // TODO: adaptar al shape real del proveedor (Meta Cloud API, Twilio, etc.)
 */
const inboundSchema = z.object({
  channel: z.enum(['whatsapp', 'sms']),
  from: z.string().min(5), // E.164 del cliente
  text: z.string().min(1).max(4000),
});

@Controller('webhooks')
export class ChannelInboundController {
  constructor(private readonly followup: FollowupService) {}

  @Post('channels')
  receive(@Body() body: unknown) {
    const parsed = inboundSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { channel, from, text } = parsed.data;
    return this.followup.receiveInbound(channel, from, text);
  }
}
