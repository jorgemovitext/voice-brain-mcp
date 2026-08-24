import { Controller, Get, Param } from '@nestjs/common';
import { ExpedienteService } from './expediente.service';

/**
 * GET /api/contacts/:id/expediente — resumen real del hilo y su caso en el CRM.
 *
 * Va aparte del contexto porque cambia mucho menos: el contexto se sondea cada
 * pocos segundos y esto consulta HubSpot. La consola lo refresca cada varias
 * vueltas, no en cada una.
 */
@Controller('api/contacts')
export class ExpedienteController {
  constructor(private readonly expediente: ExpedienteService) {}

  @Get(':id/expediente')
  de(@Param('id') id: string) {
    return this.expediente.de(id);
  }
}
