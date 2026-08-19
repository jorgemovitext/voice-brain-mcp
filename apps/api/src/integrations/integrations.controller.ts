import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { NlpearlClient } from '../nlpearl/nlpearl.client';
import { WebhookLogService } from '../shared/webhook-log.service';
import { IntegrationsService } from './integrations.service';
import { GupshupAdapter } from './whatsapp/gupshup.adapter';

const whatsappTestSchema = z.object({
  to: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Teléfono en formato E.164, por ejemplo +50497616546'),
  text: z.string().trim().min(1).max(1000).default('Prueba de conexión desde el gateway'),
});

@Controller('api/integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly nlpearl: NlpearlClient,
    private readonly gupshup: GupshupAdapter,
    private readonly webhookLog: WebhookLogService,
  ) {}

  /**
   * Envío de prueba por WhatsApp que devuelve la respuesta CRUDA del proveedor
   * y los parámetros efectivos (sin la API key). Sirve para comparar contra el
   * curl que funciona y detectar diferencias de configuración.
   * OJO: envía un mensaje real y consume saldo del proveedor.
   */
  @Post('whatsapp/test')
  async testWhatsapp(@Body() body: unknown) {
    const parsed = whatsappTestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { to, text } = parsed.data;

    if (this.integrations.whatsappProvider() !== 'gupshup') {
      return { ok: false, error: 'El proveedor activo no es Gupshup; revisá las variables.' };
    }

    const { status, data, sent } = await this.gupshup.postMessage(to, text);
    const estado = String(data?.status ?? '').toLowerCase();
    const ok = status < 400 && ['submitted', 'success', 'sent', 'queued'].includes(estado);

    this.webhookLog.push('saliente', `Prueba WhatsApp a ${to}: ${ok ? 'aceptada' : 'rechazada'} (${status})`, ok, data);
    return {
      ok,
      httpStatus: status,
      respuesta: data,
      // Lo que se envió realmente: útil para comparar con el curl que funciona.
      enviado: { ...sent, apikey: '(oculta)' },
    };
  }

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
   * Ping para comprobar que un proveedor externo puede alcanzar el gateway.
   * Deja rastro en la bitácora, así se distingue "no llega nada" de
   * "llega pero no lo entiendo".
   */
  @Get('ping')
  ping() {
    this.webhookLog.push('desconocido', 'Ping recibido en el gateway', true);
    return { ok: true, at: new Date().toISOString() };
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

      const todos = (list as Array<Record<string, unknown>>).map((p) => ({
        id: String(p['id'] ?? p['pearlId'] ?? ''),
        name: String(p['name'] ?? p['pearlName'] ?? 'sin nombre'),
      }));

      // El Pearl configurado debe existir en la cuenta: si no, las llamadas
      // fallarían recién al intentar marcar.
      const configurado = todos.find((p) => p.id === this.nlpearl.pearlId);

      this.webhookLog.push('saliente', `Prueba de conexión con NL Pearl: OK (${todos.length} Pearls)`, true);
      return {
        ok: true,
        ms: Date.now() - started,
        pearls: todos.slice(0, 12),
        total: todos.length,
        pearlEnUso: configurado
          ? { id: configurado.id, name: configurado.name, valido: true }
          : { id: this.nlpearl.pearlId, name: 'no encontrado en la cuenta', valido: false },
      };
    } catch (err) {
      const message = (err as { response?: { message?: string } }).response?.message ?? (err as Error).message;
      this.webhookLog.push('saliente', `Prueba de conexión con NL Pearl: falló — ${message}`, false);
      return { ok: false, ms: Date.now() - started, error: message };
    }
  }
}
