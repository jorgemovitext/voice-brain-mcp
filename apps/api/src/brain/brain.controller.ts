import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { BrainService } from './brain.service';
import { UnificacionService } from './unificacion.service';

/** Alta de contacto por teléfono: la llave de identidad es E.164. */
const newContactSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'El teléfono debe ir en formato E.164, por ejemplo +50588887777'),
  displayName: z.string().trim().max(120).optional(),
});

/**
 * REST para la consola Angular. Solo lectura + delegación al servicio:
 * nada de lógica de negocio en el controller.
 */
@Controller('api')
export class BrainController {
  constructor(
    private readonly brain: BrainService,
    private readonly unificacion: UnificacionService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'voice-brain-api', at: new Date().toISOString() };
  }

  /**
   * Deja un solo hilo por número, ahora.
   *
   * Corre sola al arrancar la API, pero con una ventana de 5 minutos entre
   * instancias; esto es la corrida a pedido, para no tener que esperarla.
   */
  @Post('contacts/unificar')
  async unificar() {
    const hechas = await this.unificacion.ahora();
    return {
      numeros: hechas.length,
      contactosFusionados: hechas.reduce((n: number, h) => n + h.dropIds.length, 0),
    };
  }

  @Get('contacts')
  listContacts() {
    return this.brain.listContacts();
  }

  /**
   * Inicia una conversación con un número: resuelve identidad (crea el
   * contacto si no existía) y devuelve el contacto listo para chatear.
   */
  @Post('contacts')
  async createContact(@Body() body: unknown) {
    const parsed = newContactSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { phone, displayName } = parsed.data;

    const { contactId, created } = await this.brain.resolveIdentity({
      phone,
      system: 'sender',
      displayName,
    });
    const contact = await this.brain.upsertContact({ id: contactId, displayName });
    return { contact, created };
  }

  @Get('contacts/:id/context')
  getContext(@Param('id') id: string) {
    return this.brain.getContext({ contactId: id });
  }

  @Get('contacts/:id/signals')
  getSignals(@Param('id') id: string) {
    return this.brain.getSignals(id);
  }

  /** Interacciones de voz (las "llamadas") — opcionalmente por contacto. */
  @Get('calls')
  async listCalls(@Query('contactId') contactId?: string) {
    const interactions = await this.brain.listInteractions(contactId);
    return interactions
      .filter((i) => i.channel === 'voice')
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }
}
