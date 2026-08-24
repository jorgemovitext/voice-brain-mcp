import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NlpearlActivityStore } from './activity.store';
import { PearlSyncService } from './pearl-sync.service';

const simulateChatSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Teléfono en formato E.164, por ejemplo +50499998888'),
  channel: z.enum(['whatsapp', 'sms']).default('whatsapp'),
  displayName: z.string().trim().max(120).optional(),
  mensajes: z
    .array(
      z.object({
        role: z.enum(['agent', 'customer']),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
});

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

  /**
   * Reproyecta al Brain las conversaciones ya guardadas. Se usa cuando se
   * corrige un mapeo: la API no permite releer los chats, así que el raw
   * almacenado es la única fuente para reparar el historial.
   */
  @Post('reprocess')
  reprocess(@Query('limit') limit?: string) {
    return this.sync.reprocesarChats(limit ? Number(limit) : undefined);
  }

  /**
   * Avances del flujo para un teléfono, del más viejo al más nuevo: así se
   * lee como línea de tiempo. No son mensajes — NL Pearl no expone el texto
   * de los turnos en vivo — sino el estado de la conversación.
   */
  @Get('progress')
  async progress(@Query('phone') phone?: string, @Query('limit') limit?: string) {
    // Sin teléfono devuelve los últimos de cualquier conversación: es la forma
    // de responder "¿llegó ALGÚN avance?" sin depender de acertar el formato
    // del número.
    const eventos = await this.store.listActivity({
      phone,
      kind: 'progress',
      limit: limit ? Number(limit) : 50,
    });
    return eventos
      .map((e) => {
        const raw = (e.raw ?? {}) as { conversationId?: string; paso?: string; datos?: Record<string, unknown> };
        return {
          conversationId: raw.conversationId,
          paso: raw.paso ?? 'avance',
          datos: raw.datos ?? {},
          occurredAt: e.occurredAt,
        };
      })
      .sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
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

  /**
   * Inyecta una conversación de texto de ejemplo por el mismo camino que el
   * sync real: sirve para ver en la consola cómo queda el hilo (mensajes del
   * ciudadano a la izquierda, respuestas del agente a la derecha) sin esperar
   * a que llegue una conversación de verdad.
   */
  @Post('simulate-chat')
  simulateChat(@Body() body: unknown) {
    const parsed = simulateChatSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Datos inválidos');
    const { phone, channel, displayName } = parsed.data;

    const mensajes = parsed.data.mensajes ?? [
      { role: 'customer' as const, content: 'Buenas, quiero reportar un bache grande en el Boulevard Morazán.' },
      {
        role: 'agent' as const,
        content:
          'Buenas, soy Línea 100 de la AMDC. Con gusto le ayudo con su reporte. ¿Me confirma la altura o punto de referencia más cercano?',
      },
      { role: 'customer' as const, content: 'Frente al Mall Multiplaza, en el carril hacia el centro.' },
      {
        role: 'agent' as const,
        content:
          'Registrado: bache en Boulevard Morazán frente a Multiplaza, carril hacia el centro. Su número de reporte es AMDC-4417 y lo trasladamos a la cuadrilla de bacheo. ¿Algo más en que le pueda ayudar?',
      },
    ];

    return this.sync.simulateChat({ phone, channel, displayName, mensajes });
  }
}
