import { ConfigService } from '@nestjs/config';
import { HubspotClient } from './hubspot.client';

/**
 * Abrir un ticket, que es lo que estuvo roto en producción sin dejar rastro.
 *
 * Crear un ticket no es UNA llamada: además de escribir el objeto, se lee el
 * esquema del portal y el pipeline, cada uno en su ruta y con su permiso. Con
 * un token que podía crear tickets pero no leer esas dos cosas, no se abría
 * ninguno — y el diagnóstico daba verde porque solo miraba la ruta de lectura
 * de tickets.
 */
describe('HubspotClient · crear ticket', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  /**
   * @param falla Rutas que responden 403, para simular permisos faltantes.
   */
  function build(falla: string[] = []) {
    const llamadas: Array<{ url: string; metodo: string; cuerpo: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const ruta = String(url);
      const metodo = init?.method ?? 'GET';
      llamadas.push({ url: ruta, metodo, cuerpo: init?.body ? JSON.parse(String(init.body)) : null });

      // Como el real: 204 sin cuerpo. Es lo que rompía el borrado.
      if (metodo === 'DELETE') return new Response(null, { status: 204 });
      if (ruta.includes('/crm/v3/objects/tasks')) return new Response(JSON.stringify({ id: 'T-9' }));
      if (ruta.includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [] }));

      if (falla.some((f) => ruta.includes(f))) {
        return new Response('{"message":"missing scopes"}', { status: 403 });
      }
      if (ruta.includes('/crm/v3/properties/tickets')) {
        return new Response(JSON.stringify({ results: [{ name: 'subject' }, { name: 'content' }] }));
      }
      if (ruta.includes('/crm/v3/pipelines/tickets')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                stages: [
                  { id: '4', label: 'Cerrado', displayOrder: 1, metadata: { isClosed: 'true' } },
                  { id: '1', label: 'Nuevo', displayOrder: 0, metadata: { isClosed: 'false' } },
                ],
              },
            ],
          }),
        );
      }
      if (ruta.includes('/crm/v3/objects/tickets')) {
        return new Response(JSON.stringify({ id: '4417' }));
      }
      return new Response('{}');
    }) as typeof fetch;

    const cliente = new HubspotClient({
      get: () => 'pat-na1-falso',
    } as unknown as ConfigService);
    return { cliente, llamadas };
  }

  /** El cuerpo con el que se creó el ticket. */
  const creacion = (llamadas: Array<{ url: string; metodo: string; cuerpo: Record<string, unknown> | null }>) =>
    llamadas.find((l) => l.url.endsWith('/crm/v3/objects/tickets') && l.metodo === 'POST')?.cuerpo as
      | { properties: Record<string, string> }
      | undefined;

  it('manda la etapa inicial del portal: sin eso HubSpot rechaza el ticket', async () => {
    /*
     * `hs_pipeline_stage` es obligatorio al crear. Se manda la primera etapa
     * ABIERTA que declara el portal —"Nuevo", no "Cerrado"— y por orden, no por
     * el orden en que HubSpot las devuelva.
     */
    const { cliente, llamadas } = build();

    await cliente.crearTicket({ subject: 'Bache', content: 'En la Kennedy' });

    expect(creacion(llamadas)?.properties['hs_pipeline_stage']).toBe('1');
  });

  it('sin permiso para leer el ESQUEMA, el ticket se crea igual', async () => {
    /*
     * Esto es lo que pasó en producción: el token tenía `tickets` pero no el
     * permiso de esquema, la lectura lanzaba y se llevaba puesta la creación
     * entera. Leer el esquema sirve para descartar propiedades raras — es un
     * lujo, no un requisito.
     */
    const { cliente, llamadas } = build(['/crm/v3/properties/']);

    const r = await cliente.crearTicket({ subject: 'Bache', content: 'En la Kennedy' });

    expect(r.id).toBe('4417');
    expect(creacion(llamadas)?.properties).toMatchObject({ subject: 'Bache', content: 'En la Kennedy' });
  });

  it('sin permiso para leer el PIPELINE, se intenta igual y el error lo dice HubSpot', async () => {
    // Quedarse sin abrir el ticket por no poder leer el pipeline es peor:
    // hay portales que ponen la etapa por defecto.
    const { cliente, llamadas } = build(['/crm/v3/pipelines/']);

    const r = await cliente.crearTicket({ subject: 'Bache', content: 'En la Kennedy' });

    expect(r.id).toBe('4417');
    expect(creacion(llamadas)?.properties['hs_pipeline_stage']).toBeUndefined();
  });

  it('la prueba de escritura borra el ticket Y la tarea que creó', async () => {
    /*
     * Un DELETE responde 204 sin cuerpo, y `res.json()` sobre vacío lanza
     * "Unexpected end of JSON input": un borrado que SÍ funcionó se reportaba
     * como error. Además solo se borraba el ticket, así que cada corrida
     * dejaba una tarea suelta en el CRM del cliente.
     */
    const { cliente, llamadas } = build();

    const pasos = await cliente.probarEscritura();

    const borrados = llamadas.filter((l) => l.url.includes('/objects/') && l.metodo === 'DELETE');
    expect(borrados.map((b) => b.url.split('/objects/')[1])).toEqual([
      'tickets/4417',
      'tasks/T-9',
    ]);
    expect(pasos.filter((p) => !p.ok)).toEqual([]);
  });

  it('el diagnóstico prueba el esquema y el pipeline, no solo la lectura de tickets', async () => {
    /*
     * La primera versión daba "todo verde" mientras no se creaba ni un ticket,
     * porque probaba una ruta que no es la que falla.
     */
    const { cliente } = build(['/crm/v3/properties/']);

    const { pruebas } = await cliente.permisos();
    const esquema = pruebas.find((p) => p.que.includes('ESQUEMA'));

    expect(esquema).toBeDefined();
    expect(esquema!.ok).toBe(false);
    expect(pruebas.some((p) => p.que.includes('PIPELINE'))).toBe(true);
  });
});
