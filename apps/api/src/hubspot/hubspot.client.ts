import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * El CRM de HubSpot: tickets, etapas, responsables y tareas.
 *
 * Nació solo de lectura —los tickets los creaba el flujo de NL Pearl con su
 * propia credencial y acá se miraban para el panel de casos—, pero al pasar
 * el motor a un agente nuestro la escritura quedó de este lado: ahora abre
 * los tickets y asigna las tareas.
 *
 * Sirve igual con un Service Key (`pat-na1-…`, el mecanismo nuevo) que con el
 * token de una aplicación privada: los dos viajan como Bearer.
 */

/** Alguien del portal a quien se le puede asignar una tarea. */
export interface HubspotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/** Ticket con lo mínimo para medir el ciclo de vida de un caso. */
export interface HubspotTicket {
  id: string;
  subject?: string;
  pipeline?: string;
  stage?: string;
  createdAt?: string;
  closedAt?: string;
  updatedAt?: string;
  /**
   * OJO: el objeto ticket de HubSpot NO trae teléfono de fábrica. Esto solo
   * tiene valor si el portal definió una propiedad `phone` a medida. El
   * teléfono de verdad vive en el contacto asociado — ver `ticketsPorTelefono`.
   */
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

  /** El esquema del portal cambia casi nunca; se relee cada 10 minutos. */
  private esquemaCache: { value: Map<string, Set<string> | null>; at: number } | null = null;
  /** Mismo criterio que el esquema: el equipo no cambia entre dos mensajes. */
  private ownersCache: { value: HubspotOwner[]; at: number } | null = null;
  private static readonly ESQUEMA_TTL_MS = 10 * 60 * 1000;

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

  private async pedir<T>(path: string, cuerpo?: unknown, metodo?: string): Promise<T> {
    this.assertConfigured();
    const res = await fetch(this.base + path, {
      method: metodo ?? (cuerpo === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 300);
      this.logger.warn(`HubSpot ${res.status} en ${path}: ${detalle}`);
      throw new ServiceUnavailableException(`HubSpot respondió ${res.status}: ${detalle}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Tickets de la persona dueña de ese teléfono.
   *
   * Se hace en tres saltos —contacto por teléfono, asociación contacto→ticket,
   * lectura de esos tickets— porque el objeto ticket de HubSpot NO tiene
   * propiedad de teléfono: el número vive en el CONTACTO asociado. Buscarlo
   * en el ticket (lo que hacíamos antes) no encontraba nada nunca.
   */
  async ticketsPorTelefono(telefono: string): Promise<HubspotTicket[]> {
    const contactos = await this.contactosPorTelefono(telefono);
    if (!contactos.length) return [];

    const ids = new Set<string>();
    for (const contactId of contactos) {
      const res = await this.pedir<{ results?: Array<{ toObjectId?: string | number }> }>(
        `/crm/v4/objects/contacts/${contactId}/associations/tickets?limit=100`,
      );
      // El campo es `toObjectId` y llega como número o texto según la versión.
      for (const r of res.results ?? []) if (r.toObjectId != null) ids.add(String(r.toObjectId));
    }
    if (!ids.size) return [];

    const lote = await this.pedir<{
      results?: Array<{ id: string; properties: Record<string, string | null> }>;
    }>('/crm/v3/objects/tickets/batch/read', {
      inputs: [...ids].slice(0, 100).map((id) => ({ id })),
      properties: PROPIEDADES,
    });

    return (lote.results ?? []).map((t) => HubspotClient.aTicket(t.id, t.properties ?? {}));
  }

  /**
   * Ids de contacto con ese teléfono. HubSpot indexa los números en
   * propiedades calculadas `hs_searchable_calculated_*`: las que no dicen
   * "international" guardan el número SIN código de país, así que se consulta
   * con las dos formas. Los grupos de filtro se combinan con OR.
   *
   * Es público porque la asignación de tareas necesita el id para colgarlas
   * de la ficha del ciudadano.
   */
  async contactosPorTelefono(telefono: string): Promise<string[]> {
    const digitos = telefono.replace(/\D/g, '');
    if (digitos.length < 7) return [];
    // Sin código de país: para Honduras (+504) el número nacional son 8 cifras.
    const nacional = digitos.slice(-8);
    const e164 = telefono.startsWith('+') ? telefono : `+${digitos}`;

    const grupo = (propertyName: string, value: string, operator = 'EQ') => ({
      filters: [{ propertyName, operator, value }],
    });

    const res = await this.pedir<{ results?: Array<{ id: string }> }>(
      '/crm/v3/objects/contacts/search',
      {
        filterGroups: [
          grupo('hs_searchable_calculated_phone_number', nacional),
          grupo('hs_searchable_calculated_mobile_number', nacional),
          grupo('hs_searchable_calculated_international_phone_number', e164),
          grupo('hs_searchable_calculated_international_mobile_number', e164),
          grupo('phone', `*${nacional}*`, 'CONTAINS_TOKEN'),
        ],
        properties: ['phone', 'mobilephone'],
        limit: 20,
      },
    );
    return (res.results ?? []).map((c) => c.id);
  }

  private static aTicket(id: string, p: Record<string, string | null>): HubspotTicket {
    return {
      id,
      subject: p['subject'] ?? undefined,
      pipeline: p['hs_pipeline'] ?? undefined,
      stage: p['hs_pipeline_stage'] ?? undefined,
      createdAt: p['createdate'] ?? undefined,
      closedAt: p['closed_date'] ?? undefined,
      updatedAt: p['hs_lastmodifieddate'] ?? undefined,
      phone: p['phone'] ?? undefined,
    };
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
        tickets.push(HubspotClient.aTicket(t.id, t.properties ?? {}));
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

  // =============== Escritura ===============

  /**
   * Esquema real de las propiedades de ticket del portal, cacheado.
   *
   * Es la pieza que evita repetir los errores del flujo: HubSpot rechaza el
   * POST ENTERO si mandás una propiedad que no existe (`es_demo`) o un valor
   * fuera de las opciones permitidas (`whatsapp` cuando la opción es
   * `Whatsapp`). En vez de acertar de memoria, se lee el esquema y se sanea
   * contra él.
   */
  private async propiedadesDeTicket(): Promise<Map<string, Set<string> | null>> {
    if (this.esquemaCache && Date.now() - this.esquemaCache.at < HubspotClient.ESQUEMA_TTL_MS) {
      return this.esquemaCache.value;
    }

    const res = await this.pedir<{
      results?: Array<{ name: string; options?: Array<{ value: string }> }>;
    }>('/crm/v3/properties/tickets');

    const mapa = new Map<string, Set<string> | null>();
    for (const p of res.results ?? []) {
      // null = campo libre; Set = enumerado con opciones cerradas.
      mapa.set(p.name, p.options?.length ? new Set(p.options.map((o) => o.value)) : null);
    }
    this.esquemaCache = { value: mapa, at: Date.now() };
    return mapa;
  }

  /**
   * Deja solo lo que el portal acepta y corrige los enumerados que difieren
   * únicamente en mayúsculas. Devuelve también lo descartado: callar un campo
   * que se perdió sería peor que el error original.
   */
  private async sanear(
    props: Record<string, string>,
  ): Promise<{ limpias: Record<string, string>; descartadas: string[] }> {
    const esquema = await this.propiedadesDeTicket();
    const limpias: Record<string, string> = {};
    const descartadas: string[] = [];

    for (const [nombre, valor] of Object.entries(props)) {
      if (!valor?.trim()) continue;
      if (!esquema.has(nombre)) {
        descartadas.push(`${nombre} (no existe en el portal)`);
        continue;
      }
      const opciones = esquema.get(nombre);
      if (!opciones) {
        limpias[nombre] = valor;
        continue;
      }
      const exacta = opciones.has(valor)
        ? valor
        : [...opciones].find((o) => o.toLowerCase() === valor.toLowerCase());
      if (exacta) limpias[nombre] = exacta;
      else descartadas.push(`${nombre}="${valor}" (opción inválida)`);
    }
    return { limpias, descartadas };
  }

  /**
   * Crea el ticket y lo asocia al contacto del teléfono, que es lo que hace
   * que después aparezca en la tarjeta "Caso en el CRM" — el emparejamiento
   * es por asociación, no por una propiedad de teléfono en el ticket.
   */
  /**
   * La gente del portal a la que se le puede asignar trabajo.
   *
   * Se cachea diez minutos: el equipo de la alcaldía no cambia entre dos
   * mensajes de una conversación, y esto se consulta en cada asignación.
   */
  async responsables(): Promise<HubspotOwner[]> {
    const fresco = this.ownersCache && Date.now() - this.ownersCache.at < HubspotClient.ESQUEMA_TTL_MS;
    if (fresco) return this.ownersCache!.value;

    const res = await this.pedir<{ results?: HubspotOwner[] }>('/crm/v3/owners?limit=200');
    const value = res.results ?? [];
    this.ownersCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Crea una tarea y se la asigna a alguien, colgada del contacto.
   *
   * `hs_timestamp` es lo ÚNICO obligatorio de la API y es el vencimiento: sin
   * fecha la tarea no existe para HubSpot. Se usa "ahora" cuando no se indica
   * otra cosa, que para un reporte ciudadano es lo correcto — se atiende hoy.
   */
  async crearTarea(input: {
    titulo: string;
    detalle?: string;
    /** EMAIL | CALL | TODO — son los únicos que acepta HubSpot. */
    tipo?: 'EMAIL' | 'CALL' | 'TODO';
    prioridad?: 'LOW' | 'MEDIUM' | 'HIGH';
    ownerId?: string;
    /** Contacto al que se cuelga la tarea, para que aparezca en su ficha. */
    contactoId?: string;
    venceEn?: Date;
  }): Promise<{ id: string }> {
    const props: Record<string, string> = {
      hs_timestamp: (input.venceEn ?? new Date()).toISOString(),
      hs_task_subject: input.titulo,
      hs_task_status: 'NOT_STARTED',
      hs_task_type: input.tipo ?? 'TODO',
      hs_task_priority: input.prioridad ?? 'HIGH',
    };
    if (input.detalle) props['hs_task_body'] = input.detalle;
    if (input.ownerId) props['hubspot_owner_id'] = input.ownerId;

    return this.pedir<{ id: string }>('/crm/v3/objects/tasks', {
      properties: props,
      // 204 = tarea → contacto, en el catálogo de asociaciones de HubSpot.
      // Sin esto la tarea existe pero suelta, y nadie la encuentra desde la
      // ficha del ciudadano.
      associations: input.contactoId
        ? [
            {
              to: { id: input.contactoId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }],
            },
          ]
        : [],
    });
  }

  /**
   * Por qué el CRM no hace lo que debería, con evidencia en vez de sospechas.
   *
   * Existe porque "no se crean las tareas" puede ser cinco cosas —token
   * ausente, permiso faltante, portal sin responsables, error de red— y desde
   * afuera todas se ven igual: no pasa nada. Acá cada capacidad se prueba por
   * separado y se dice cuál falló y con qué respondió HubSpot.
   *
   * Solo lecturas: no escribe nada en el portal.
   */
  async permisos(): Promise<{
    configurado: boolean;
    permisos: string[] | null;
    pruebas: Array<{ que: string; ok: boolean; detalle: string }>;
  }> {
    if (!this.token) {
      return { configurado: false, permisos: null, pruebas: [] };
    }

    // Los permisos que el portal le dio al token, en sus propias palabras.
    let permisos: string[] | null = null;
    try {
      const res = await fetch('https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenKey: this.token }),
      });
      if (res.ok) permisos = ((await res.json()) as { scopes?: string[] }).scopes ?? [];
    } catch {
      // Es un extra: si no se puede leer, las pruebas de abajo igual dicen algo.
    }

    const probar = async (que: string, path: string) => {
      try {
        const res = await fetch(this.base + path, { headers: { Authorization: `Bearer ${this.token}` } });
        const cuerpo = res.ok ? '' : (await res.text()).slice(0, 200);
        return { que, ok: res.ok, detalle: res.ok ? 'ok' : `${res.status} ${cuerpo}` };
      } catch (err) {
        return { que, ok: false, detalle: (err as Error).message };
      }
    };

    const pruebas = await Promise.all([
      probar('Leer responsables (para asignar tareas)', '/crm/v3/owners?limit=1'),
      probar('Leer tareas', '/crm/v3/objects/tasks?limit=1'),
      probar('Leer tickets', '/crm/v3/objects/tickets?limit=1'),
      probar('Leer contactos (para colgarles la tarea)', '/crm/v3/objects/contacts?limit=1'),
    ]);

    // Cuántos responsables hay de verdad: con cero, el agente no tiene a quién
    // asignarle nada y la tarea queda huérfana aunque todo lo demás funcione.
    if (pruebas[0].ok) {
      const gente = await this.responsables().catch(() => []);
      pruebas.push({
        que: 'Responsables configurados en el portal',
        ok: gente.length > 0,
        detalle: gente.length ? `${gente.length} disponibles` : 'ninguno: no hay a quién asignarle la tarea',
      });
    }

    return { configurado: true, permisos, pruebas };
  }

  /**
   * Le pone dueño a una tarea que ya existe.
   *
   * Registrar un reporte crea la tarea sin responsable —acá nadie sabe a quién
   * le toca un bache en la Kennedy— y el agente se lo pone después. Modificar
   * es lo correcto y no crear otra: dos tarjetas para el mismo bache, una sin
   * nadie, es peor que la tarea original sin dueño.
   */
  async asignarTarea(
    tareaId: string,
    ownerId: string,
    prioridad?: 'LOW' | 'MEDIUM' | 'HIGH',
  ): Promise<void> {
    await this.pedir(
      `/crm/v3/objects/tasks/${tareaId}`,
      { properties: { hubspot_owner_id: ownerId, ...(prioridad ? { hs_task_priority: prioridad } : {}) } },
      'PATCH',
    );
  }

  async crearTicket(
    props: Record<string, string>,
    telefono?: string,
  ): Promise<{ id: string; descartadas: string[] }> {
    const { limpias, descartadas } = await this.sanear(props);
    if (descartadas.length) {
      this.logger.warn(`Ticket creado sin: ${descartadas.join(', ')}`);
    }

    const creado = await this.pedir<{ id: string }>('/crm/v3/objects/tickets', {
      properties: limpias,
    });

    if (telefono) {
      await this.asociarAlContacto(creado.id, telefono).catch((err) => {
        // El ticket ya existe: perder la asociación no justifica fallar todo.
        this.logger.warn(`Ticket ${creado.id} creado pero sin asociar: ${(err as Error).message}`);
      });
    }
    return { id: creado.id, descartadas };
  }

  /** Asocia el ticket al contacto dueño de ese teléfono, si existe. */
  private async asociarAlContacto(ticketId: string, telefono: string): Promise<void> {
    const [contactId] = await this.contactosPorTelefono(telefono);
    if (!contactId) return;
    await this.pedir(
      `/crm/v4/objects/tickets/${ticketId}/associations/default/contacts/${contactId}`,
      {},
      'PUT',
    );
  }
}
