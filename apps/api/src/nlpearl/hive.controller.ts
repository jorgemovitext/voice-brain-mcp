import { Controller, Get } from '@nestjs/common';
import { HiveService } from './hive.service';

/**
 * GET /api/hive — el estado de la colmena para la primera pantalla.
 * Solo lecturas; el refresco de datos lo dispara la consola con el sync soft.
 */
@Controller('api/hive')
export class HiveController {
  constructor(private readonly hive: HiveService) {}

  @Get()
  status() {
    return this.hive.status();
  }
}
