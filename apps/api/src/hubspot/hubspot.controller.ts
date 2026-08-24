import { Controller, Get } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from './hubspot.client';

/**
 * Diagnóstico del CRM antes de construir el panel de casos.
 *
 * La razón de existir: los tickets los crea el flujo de NL Pearl, y en este
 * proyecto ya se comprobó varias veces que ese flujo reporta cosas que no
 * hace. Dibujar métricas sobre tickets sin antes contrastarlos con nuestras
 * conversaciones sería confiar a ciegas — este endpoint es el contraste.
 */
@Controller('api/hubspot')
export class HubspotController {
  constructor(
    private readonly hubspot: HubspotClient,
    private readonly brain: BrainService,
  ) {}

  @Get('diagnostico')
  async diagnostico() {
    if (!this.hubspot.configured) {
      return { configurado: false, motivo: 'Falta HUBSPOT_TOKEN en el entorno' };
    }

    const [{ tickets, truncado }, etapas, contactos] = await Promise.all([
      this.hubspot.listarTickets(),
      this.hubspot.etapas(),
      this.brain.listContacts(),
    ]);

    // Cuántos tickets hay en cada etapa, con su nombre legible.
    const porEtapa = new Map<string, { etapa: string; cerrada: boolean; total: number }>();
    let cerrados = 0;
    for (const t of tickets) {
      const info = t.stage ? etapas.get(t.stage) : undefined;
      const clave = info?.label ?? t.stage ?? 'sin etapa';
      const cerrada = info?.isClosed ?? false;
      if (cerrada) cerrados++;
      const actual = porEtapa.get(clave) ?? { etapa: clave, cerrada, total: 0 };
      actual.total++;
      porEtapa.set(clave, actual);
    }

    // El contraste que importa: conversaciones nuestras vs tickets del CRM.
    const conversaciones = contactos.filter((c) => c.lastInteraction).length;

    return {
      configurado: true,
      tickets: {
        total: tickets.length,
        truncado,
        cerrados,
        enCurso: tickets.length - cerrados,
        porEtapa: [...porEtapa.values()].sort((a, b) => b.total - a.total),
        masAntiguo: tickets.reduce<string | undefined>(
          (min, t) => (t.createdAt && (!min || t.createdAt < min) ? t.createdAt : min),
          undefined,
        ),
      },
      etapasDelPipeline: [...etapas.values()]
        .sort((a, b) => a.order - b.order)
        .map((e) => ({ etapa: e.label, cierraElCaso: e.isClosed })),
      nuestrasConversaciones: conversaciones,
      /** Si esto no da ~0, el flujo no está creando un ticket por conversación. */
      diferencia: conversaciones - tickets.length,
    };
  }
}
