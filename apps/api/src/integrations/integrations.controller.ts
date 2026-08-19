import { Controller, Get } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';

@Controller('api/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /** Estado de las integraciones para la consola (nunca devuelve secretos). */
  @Get()
  list() {
    return this.integrations.list();
  }
}
