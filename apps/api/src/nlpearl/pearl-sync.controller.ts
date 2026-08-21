import { Controller, Get, Post, Query } from '@nestjs/common';
import { NlpearlActivityStore } from './activity.store';
import { PearlSyncService } from './pearl-sync.service';

/**
 * Espejo NL Pearl vía HTTP:
 *   POST /api/nlpearl/sync            — recorre las pearls y trae la actividad del rango
 *   POST /api/nlpearl/sync?soft=true  — variante con rate-limit (para colgar del refresh)
 *   GET  /api/nlpearl/activity        — detalle raw almacenado (por pearl / teléfono)
 *   GET  /api/nlpearl/pearls          — catálogo espejado con su canal asignado
 */
@Controller('api/nlpearl')
export class PearlSyncController {
  constructor(
    private readonly sync: PearlSyncService,
    private readonly store: NlpearlActivityStore,
  ) {}

  @Post('sync')
  runSync(
    @Query('hours') hours?: string,
    @Query('pearlId') pearlId?: string,
    @Query('soft') soft?: string,
  ) {
    const h = hours ? Number(hours) : 24;
    if (soft === 'true') return this.sync.syncIfDue(h);
    return this.sync.syncAll({ hours: h, pearlId });
  }

  @Get('activity')
  activity(
    @Query('pearlId') pearlId?: string,
    @Query('phone') phone?: string,
    @Query('limit') limit?: string,
  ) {
    return this.store.listActivity({ pearlId, phone, limit: limit ? Number(limit) : undefined });
  }

  @Get('pearls')
  pearls() {
    return this.store.listPearls();
  }
}
