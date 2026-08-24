import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Lectura del CRM de HubSpot: tickets y sus etapas.
 *
 * Solo lee. Los tickets los crea el flujo de NL Pearl con su propia
 * credencial; acá nos limitamos a mirarlos para el panel de casos. Sirve
 * igual con un Service Key (`pat-na1-…`, el mecanismo nuevo) que con el token
 * de una aplicación privada: los dos viajan como Bearer.
 */

/** Ticket con lo mínimo para medir el ciclo de vida de un caso. */
export interface HubspotTicket {
  id: string;
  subject?: string;
  pipeline?: string;
  stage?: string;
  createdAt?: string;
  closedAt?: string;
  updatedAt?: string;
  /** Teléfono asociado, cuando el flujo lo guardó en el ticket. */
  phone?: string;
}

/** Etapa de un pipeline: el `isClosed` es lo que separa "resuelto" de "en curso". */
export interface HubspotStage {
  id: string;
  label: string;
  isClosed: boolean;
  order: number;
}

const PROPIEDADES = [
  'subject',
  'hs_pipeline',
  'hs_pipeline_stage',
  'createdate',
  'closed_date',
  'hs_lastmodifieddate',
  'hs_ticket_priority',
  'phone',
];

@Injectable()
export class HubspotClient {
  private readonly logger = new Logger(HubspotClient.name);
  private readonly token: string;
  private readonly base = 'https://api.hubapi.com';

  constructor(config: ConfigService) {
    this.token = config.get<string>('HUBSPOT_TOKEN', '');
  }

  get configured(): boolean {
    return !!this.token;
  }

  private assertConfigured(): void {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'Falta HUBSPOT_TOKEN. Cargalo como variable de entorno (Service Key o token de app privada).',
      );
    }
  }

  private async pedir<T>(path: string): Promise<T> {
    this.assertConfigured();
    const res = await fetch(this.base + path, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 300);
      this.logger.warn(`HubSpot ${res.status} en ${path}: ${detalle}`);
      throw new ServiceUnavailableException(`HubSpot respondió ${res.status}: ${detalle}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Todos los tickets, paginando. El tope existe para que un CRM grande no
   * cuelgue la función serverless: si se alcanza, se avisa en vez de mentir
   * con un total incompleto.
   */
  async listarTickets(maximo = 500): Promise<{ tickets: HubspotTicket[]; truncado: boolean }> {
    const tickets: HubspotTicket[] = [];
    let after: string | undefined;

    do {
      const qs = new URLSearchParams({ limit: '100', properties: PROPIEDADES.join(',') });
      if (after) qs.set('after', after);
      const pagina = await this.pedir<{
        results: Array<{ id: string; properties: Record<string, string | null> }>;
        paging?: { next?: { after?: string } };
      }>(`/crm/v3/objects/tickets?${qs}`);

      for (const t of pagina.results ?? []) {
        const p = t.properties ?? {};
        tickets.push({
          id: t.id,
          subject: p['subject'] ?? undefined,
          pipeline: p['hs_pipeline'] ?? undefined,
          stage: p['hs_pipeline_stage'] ?? undefined,
          createdAt: p['createdate'] ?? undefined,
          closedAt: p['closed_date'] ?? undefined,
          updatedAt: p['hs_lastmodifieddate'] ?? undefined,
          phone: p['phone'] ?? undefined,
        });
      }
      after = pagina.paging?.next?.after;
    } while (after && tickets.length < maximo);

    return { tickets, truncado: Boolean(after) };
  }

  /** Etapas de los pipelines de ticket, indexadas por id. */
  async etapas(): Promise<Map<string, HubspotStage>> {
    const res = await this.pedir<{
      results: Array<{
        stages: Array<{ id: string; label: string; displayOrder: number; metadata?: { isClosed?: string | boolean } }>;
      }>;
    }>('/crm/v3/pipelines/tickets');

    const mapa = new Map<string, HubspotStage>();
    for (const pipeline of res.results ?? []) {
      for (const s of pipeline.stages ?? []) {
        mapa.set(s.id, {
          id: s.id,
          label: s.label,
          // HubSpot devuelve isClosed como string "true"/"false" en algunos planes.
          isClosed: s.metadata?.isClosed === true || s.metadata?.isClosed === 'true',
          order: s.displayOrder ?? 0,
        });
      }
    }
    return mapa;
  }
}
