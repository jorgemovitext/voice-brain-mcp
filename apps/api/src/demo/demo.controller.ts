import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { FollowupService } from '../channels/followup.service';
import { DemoService } from './demo.service';

const triggerSchema = z.object({
  contactId: z.string().min(1),
  /** Pearl puntual para esta llamada; si falta se usa la asignada a voz. */
  pearlId: z.string().trim().max(64).optional(),
});
const followupSchema = z.object({ channel: z.enum(['whatsapp', 'sms']).optional() });
const messageSchema = z.object({
  text: z.string().min(1).max(2000),
  channel: z.enum(['whatsapp', 'sms']).optional(),
});

/**
 * Acciones de la consola: correr la demo, disparar llamadas y
 * enviar seguimientos manuales. Lógica en los services.
 */
@Controller('api')
export class DemoController {
  constructor(private readonly demo: DemoService, private readonly followup: FollowupService) {}

  @Post('demo/run')
  run() {
    return this.demo.run();
  }

  /** Práctica: llamada entrante + WhatsApp entrante del mismo número. */
  @Post('demo/run-inbound')
  runInbound() {
    return this.demo.runInbound();
  }

  @Get('demo/status')
  status() {
    return this.demo.status();
  }

  /** Botón "Llamar (demo)" — dispara addLead para un contacto existente. */
  @Post('calls/trigger')
  trigger(@Body() body: unknown) {
    const parsed = triggerSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.demo.triggerCall(parsed.data.contactId, parsed.data.pearlId);
  }

  /** Mensaje libre del operador desde el composer del chat. */
  @Post('contacts/:id/messages')
  sendMessage(@Param('id') id: string, @Body() body: unknown) {
    const parsed = messageSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.followup.sendMessage(id, parsed.data.text, parsed.data.channel);
  }

  /** Botón "Enviar seguimiento por WhatsApp" de la vista de contexto. */
  @Post('contacts/:id/followup')
  sendFollowup(@Param('id') id: string, @Body() body: unknown) {
    const parsed = followupSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.followup.sendFollowup(id, parsed.data.channel);
  }
}
