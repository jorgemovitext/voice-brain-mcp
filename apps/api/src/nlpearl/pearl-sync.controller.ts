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

  /**
   * Estado de la conversación más reciente de cada teléfono, para el listado.
   *
   * Existe porque una conversación recién abierta no tiene NI UN mensaje —el
   * hilo completo llega al cerrar—, así que el listado, que ordena por el
   * último mensaje, la mandaba al fondo justo cuando era lo más urgente.
   *
   * Va acá y no en `/api/contacts` porque los avances viven en este módulo,
   * y BrainModule no puede importarlo sin cerrar un ciclo.
   */
  @Get('en-curso')
  async enCurso(): Promise<Array<{ phone: string; lastFlowAt: string; inconclusa: boolean }>> {
    const avances = await this.store.listActivity({ kind: 'progress', limit: 400 });

    /*
     * Se agrupa por teléfono y, dentro, por conversación: el mismo número
     * reporta varias veces y solo interesa en qué quedó la ÚLTIMA.
     */
    const porTelefono = new Map<string, Map<string, { pasos: Set<string>; ultimo: string }>>();
    for (const a of avances) {
      const tel = (a.phone ?? '').replace(/\D/g, '');
      const raw = (a.raw ?? {}) as { conversationId?: string; paso?: string };
      if (!tel || !a.occurredAt || !raw.conversationId) continue;

      const conversaciones = porTelefono.get(tel) ?? new Map();
      const c = conversaciones.get(raw.conversationId) ?? { pasos: new Set<string>(), ultimo: '' };
      if (raw.paso) c.pasos.add(raw.paso.toLowerCase());
      if (a.occurredAt > c.ultimo) c.ultimo = a.occurredAt;
      conversaciones.set(raw.conversationId, c);
      porTelefono.set(tel, conversaciones);
    }

    return [...porTelefono].map(([phone, conversaciones]) => {
      const ultima = [...conversaciones.values()].sort((a, b) => b.ultimo.localeCompare(a.ultimo))[0];
      return {
        phone,
        lastFlowAt: ultima.ultimo,
        inconclusa: PearlSyncController.quedoInconclusa(ultima),
      };
    });
  }

  /**
   * Una conversación quedó inconclusa cuando el agente dejó de recibir
   * respuesta y nunca llegó a cerrar el caso.
   *
   * La regla sale de NUESTROS datos y no del estado que reporta NL Pearl:
   * los listados de su API devuelven cero para esta cuenta, así que el estado
   * de una conversación concreta no se puede consultar. Lo que sí tenemos son
   * los avances del flujo, y ahí se ve si pasó por un nodo de cierre.
   *
   * "Dejó de moverse" son 15 minutos: el flujo empuja un avance por paso, y
   * una conversación viva no pasa ese rato en silencio. Menos que eso
   * marcaría como abandonada a alguien que está escribiendo.
   */
  private static readonly CIERRA = ['regist', 'farewell', 'closing', 'escalamiento'];
  private static readonly QUIETA_MS = 15 * 60_000;

  private static quedoInconclusa(c: { pasos: Set<string>; ultimo: string }): boolean {
    const cerro = [...c.pasos].some((p) => PearlSyncController.CIERRA.some((k) => p.includes(k)));
    if (cerro) return false;
    return Date.now() - new Date(c.ultimo).getTime() > PearlSyncController.QUIETA_MS;
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
