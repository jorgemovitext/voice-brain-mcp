import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BrainService } from '../brain/brain.service';
import { FollowupService } from '../channels/followup.service';
import { DemoService } from './demo.service';

const triggerSchema = z.object({
  contactId: z.string().min(1),
  /** Pearl puntual para esta llamada; si falta se usa la asignada a voz. */
  pearlId: z.string().trim().max(64).optional(),
});
const followupSchema = z.object({ channel: z.enum(['whatsapp', 'sms']).optional() });
const noteSchema = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * Acciones de la consola: correr la demo, disparar llamadas y
 * enviar seguimientos manuales. Lógica en los services.
 */
@Controller('api')
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly followup: FollowupService,
    private readonly brain: BrainService,
  ) {}

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

  /**
   * Composer del chat = NOTA INTERNA. Los agentes (Pearls) conversan con el
   * cliente por sus propios canales; lo que escribe el operador acá queda en
   * el hilo para el equipo y no sale por ningún canal. Se firma con el
   * teléfono de la sesión para saber quién la dejó.
   */
  @Post('contacts/:id/notes')
  addNote(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { user?: { phone?: string } },
  ) {
    const parsed = noteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.brain.addInternalNote(id, parsed.data.text, req.user?.phone);
  }

  /** Botón "Enviar seguimiento por WhatsApp" de la vista de contexto. */
  @Post('contacts/:id/followup')
  sendFollowup(@Param('id') id: string, @Body() body: unknown) {
    const parsed = followupSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.followup.sendFollowup(id, parsed.data.channel);
  }
}
