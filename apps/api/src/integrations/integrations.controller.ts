import { Controller, Get, Post } from '@nestjs/common';
import { NlpearlClient } from '../nlpearl/nlpearl.client';
import { WebhookLogService } from '../shared/webhook-log.service';
import { IntegrationsService } from './integrations.service';

@Controller('api/integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly nlpearl: NlpearlClient,
    private readonly webhookLog: WebhookLogService,
  ) {}

  /** Estado de las integraciones para la consola (nunca devuelve secretos). */
  @Get()
  list() {
    return this.integrations.list();
  }

  /** Actividad reciente de webhooks: sirve para ver si los proveedores nos pegan. */
  @Get('activity')
  activity() {
    return this.webhookLog.list();
  }

  /**
   * Prueba de conexión con NL Pearl: pide el listado de Pearls, que es una
   * lectura y no gasta llamadas ni créditos. Si responde, las credenciales
   * están bien y la API contesta.
   */
  @Post('nlpearl/test')
  async testNlpearl() {
    const started = Date.now();
    try {
      this.nlpearl.assertConfigured();
      const pearls = (await this.nlpearl.getPearls()) as unknown;
      const list = Array.isArray(pearls) ? pearls : ((pearls as { data?: unknown[] })?.data ?? []);

      const resumen = (list as Array<Record<string, unknown>>).slice(0, 10).map((p) => ({
        id: String(p['id'] ?? p['pearlId'] ?? ''),
        name: String(p['name'] ?? p['pearlName'] ?? 'sin nombre'),
      }));

      this.webhookLog.push('saliente', `Prueba de conexión con NL Pearl: OK (${resumen.length} Pearls)`, true);
      return { ok: true, ms: Date.now() - started, pearls: resumen };
    } catch (err) {
      const message = (err as { response?: { message?: string } }).response?.message ?? (err as Error).message;
      this.webhookLog.push('saliente', `Prueba de conexión con NL Pearl: falló — ${message}`, false);
      return { ok: false, ms: Date.now() - started, error: message };
    }
  }
}
