import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/**
 * GET /api/analytics — el panel de fondo de La colmena.
 *
 * Va aparte de /api/hive a propósito: la primera pantalla se refresca cada
 * pocos segundos y esto recorre todo el histórico. Mezclarlos haría que el
 * sondeo pague el costo del análisis en cada vuelta.
 */
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  resumen(@Query('dias') dias?: string, @Query('canal') canal?: string) {
    const d = Number(dias);
    const canales = ['voice', 'whatsapp', 'sms', 'email'];
    return this.analytics.resumen(
      Number.isFinite(d) && d > 0 && d <= 90 ? d : 14,
      canal && canales.includes(canal) ? (canal as never) : undefined,
    );
  }
}
