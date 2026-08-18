import { Controller, Get, Param, Query } from '@nestjs/common';
import { BrainService } from './brain.service';

/**
 * REST para la consola Angular. Solo lectura + delegación al servicio:
 * nada de lógica de negocio en el controller.
 */
@Controller('api')
export class BrainController {
  constructor(private readonly brain: BrainService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'voice-brain-api', at: new Date().toISOString() };
  }

  @Get('contacts')
  listContacts() {
    return this.brain.listContacts();
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
