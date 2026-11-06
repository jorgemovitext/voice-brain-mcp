import { AgenteActivoService } from '../shared/agente-activo.service';
import { BrainService } from '../brain/brain.service';
import { AtencionService } from '../shared/atencion.service';
import { WebhookLogService } from '../shared/webhook-log.service';
import { LineasService } from '../lineas/lineas.service';
import { WhatsappInboundService } from './whatsapp-inbound.service';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { ChannelPort } from '../ports/channel.port';
import { ORG_HISTORICA, orgActual } from '../shared/contexto-org';

/**
 * Qué entra al hilo y qué no.
 *
 * Los ciudadanos conversan con los agentes por el canal de NL Pearl, así que
 * meter TODO lo que llega por Gupshup crearía hilos duplicados y sin agente.
 * Pero cuando un operador toma una conversación, la app le escribe por
 * Gupshup y la respuesta vuelve por acá: dejarla solo en la bitácora hacía
 * que el operador escribiera a ciegas.
 */
/** El agente activo de los tests: todo pertenece al activo. */
const ACTIVO_DE_PRUEBA = {
  id: async () => 'ag-1',
  filtroDeHilos: async () => () => true,
} as unknown as AgenteActivoService;

describe('WhatsappInboundService', () => {
  const TEL = '+50497616546';

  /** Un mensaje entrante en el formato propio de Gupshup. */
  const mensaje = (texto: string, id = 'm1') => ({
    type: 'message',
    payload: {
      id,
      source: TEL,
      sender: { phone: TEL, name: 'Jorge' },
      payload: { text: texto },
    },
  });

  /**
   * @param operador  Quién atiende cada contacto del número. Es un mapa y no
   *                  un valor suelto porque el mismo teléfono puede tener
   *                  varios contactos, y el que importa es el TOMADO.
   * @param contactos Los contactos que comparten ese número.
   */
  function build({
    operador,
    contactos = ['c1'],
    respuestaAgente = null,
    lineas = {},
    duenas = {},
    derivacion,
  }: {
    operador: Record<string, string | null>;
    contactos?: string[];
    /** Qué contesta el agente. null = motor apagado (el caso por defecto). */
    respuestaAgente?: string | null;
    /** destino → agente de la línea, para probar el routing multi-cliente. */
    lineas?: Record<string, string>;
    /** destino → empresa dueña de esa línea. A ella se le factura. */
    duenas?: Record<string, string>;
    /** Qué decide el motor de traspaso para este caso. */
    derivacion?: {
      decision?: { agente: string; tema: string; confianza: number; accion: 'cambiar' | 'preguntar' } | null;
      delHilo?: string | null;
      propuesta?: { agente: string; tema: string } | null;
    };
  }) {
    const guardadas: Array<Record<string, unknown>> = [];
    const bitacora: string[] = [];

    const enviados: Array<{ contactId: string; texto: string; org?: string }> = [];
    const brain = {
      // No crea: preguntar por un número no debe dar de alta a nadie.
      findAllByPhone: async () => contactos.map((id) => ({ id })),
      // El agente SÍ da de alta, porque ahí sí hay una conversación real.
      resolveIdentity: async () => ({ contactId: 'nuevo', created: true }),
      appendInteraction: async (i: Record<string, unknown>) => {
        // Se anota la empresa VIGENTE en el momento de guardar: es lo que
        // decide de quién son los datos y a quién se le cobra.
        guardadas.push({ ...i, __org: orgActual() });
        return i;
      },
    };
    const atendidoPor: string[] = [];
    const agente = {
      configurado: () => respuestaAgente !== null,
      responderEnHilo: async (_c: string, _t: string, agenteId?: string) => {
        atendidoPor.push(agenteId ?? 'sin-agente');
        return respuestaAgente;
      },
    };
    const lineasService = {
      agenteDe: async (destino?: string) =>
        destino && lineas[destino]
          ? { agente: lineas[destino], linea: `linea-${destino}`, organizacion: duenas[destino] }
          : null,
    };
    const canal = {
      send: async (contactId: string, texto: string) => {
        enviados.push({ contactId, texto, org: orgActual() });
        return { delivered: true, providerId: 'p1' };
      },
    };
    const atencion = { de: async (id: string) => ({ operador: operador[id] ?? null }) };

    /** El motor de traspaso, con su memoria de hilo en una variable. */
    const traspasos: Array<{ contactId: string; agente: string }> = [];
    const cortados: string[] = [];
    const inscritos: string[] = [];
    const propuestas: Array<{ contactId: string; agente: string }> = [];
    let delHilo = derivacion?.delHilo ?? null;
    let propuestaViva = derivacion?.propuesta ?? null;

    const derivacionSvc = {
      agenteDelHilo: async () => delHilo,
      fijarAgenteDelHilo: async (c: string, a: string) => {
        delHilo = a;
        traspasos.push({ contactId: c, agente: a });
      },
      anotarCambio: async () => undefined,
      decidir: async () => derivacion?.decision ?? null,
      propuesta: async () => propuestaViva,
      proponer: async (c: string, a: string) => {
        propuestas.push({ contactId: c, agente: a });
      },
      olvidarPropuesta: async () => {
        propuestaViva = null;
      },
    };
    const agentesSvc = { nombreDe: async (id: string) => `Nombre de ${id}` };

    /*
     * El seguimiento, con lo que importa acá: a quién se cortó y a quién se
     * inscribió. Es lo que deja comprobar que contestar mata la secuencia —
     * el freno sin el cual el módulo se vuelve acoso.
     */
    const seguimientoSvc = {
      cortar: async (contacto: string) => {
        cortados.push(contacto);
        return 1;
      },
      inscribirAutomaticas: async (contacto: string) => {
        inscritos.push(contacto);
        return 1;
      },
    };

    const service = new WhatsappInboundService(
      brain as unknown as BrainService,
      atencion as unknown as AtencionService,
      { push: (_o: string, texto: string) => bitacora.push(texto) } as unknown as WebhookLogService,
      agente as unknown as ElevenLabsService,
      lineasService as unknown as LineasService,
      derivacionSvc as never,
      agentesSvc as never,
      ACTIVO_DE_PRUEBA,
      seguimientoSvc as never,
      canal as unknown as ChannelPort,
    );
    return { service, guardadas, bitacora, enviados, atendidoPor, traspasos, propuestas, cortados, inscritos };
  }

  it('la respuesta del ciudadano entra al hilo que un operador tomó', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(mensaje('Sí, es en la esquina de la cancha'), 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({
      contactId: 'c1',
      channel: 'whatsapp',
      direction: 'inbound',
      summary: 'Sí, es en la esquina de la cancha',
    });
  });

  it('una imagen entrante entra al hilo como adjunto, no se descarta', async () => {
    // Formato Meta (el que manda el Gupshup del usuario): media = {id, caption},
    // sin texto. Antes se tiraba por no tener `text` y no aparecía en el chat.
    const imagenMeta = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: 'Jorge' } }],
                messages: [
                  { id: 'img1', from: TEL.slice(1), type: 'image', image: { id: 'MEDIA123', caption: 'la fuga' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(imagenMeta, 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'c1', attachment: 'foto', summary: 'la fuga' });
  });

  it('un audio de Gupshup v2 entra con su URL para poder escucharlo', async () => {
    const audio = {
      type: 'message',
      payload: {
        id: 'aud1',
        source: TEL,
        type: 'audio',
        sender: { phone: TEL, name: 'Jorge' },
        payload: { url: 'https://filemanager.gupshup.io/aud1.ogg', contentType: 'audio/ogg' },
      },
    };
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(audio, 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({
      attachment: 'audio',
      summary: 'Audio recibido',
      attachmentUrl: 'https://filemanager.gupshup.io/aud1.ogg',
    });
  });

  it('sin hilo tomado se queda en la bitácora: el agente atiende por NL Pearl', async () => {
    const { service, guardadas, bitacora } = build({ operador: { c1: null } });

    await service.process(mensaje('Hola'), 'gupshup');

    expect(guardadas).toHaveLength(0);
    // El motivo, no solo el rechazo: lo resuelve el operador con un clic.
    expect(bitacora[0]).toContain('nadie tomó esa conversación');
  });

  it('un número desconocido no crea un contacto fantasma', async () => {
    const { service, guardadas, bitacora } = build({ operador: {}, contactos: [] });

    await service.process(mensaje('Número que nunca escribió'), 'gupshup');

    expect(guardadas).toHaveLength(0);
    /*
     * Y se distingue del caso de arriba. Los dos terminan en "no entra al
     * Brain", pero uno lo arregla el operador tomando el hilo y el otro es un
     * fallo de emparejado de teléfonos que hay que corregir en el código.
     */
    expect(bitacora[0]).toContain('no hay ninguna conversación con ese número');
  });

  it('con contactos duplicados del mismo número, entra al que está tomado', async () => {
    /*
     * El teléfono llegó a tener varios contactos: antes de emparejar por
     * dígitos, cada formato distinto daba de alta uno nuevo. La consulta
     * devolvía el primero, que no tiene por qué ser el que el operador tomó,
     * y el mensaje quedaba fuera con un rechazo que contradecía la pantalla:
     * la app mostraba el hilo tomado y la bitácora decía que nadie lo tomó.
     */
    const { service, guardadas } = build({
      operador: { duplicado: null, tomado: 'Jorge Murcia' },
      contactos: ['duplicado', 'tomado'],
    });

    await service.process(mensaje('Ya la tomé, respondeme acá'), 'gupshup');

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'tomado' });
  });

  it('con el agente encendido, contesta él y la respuesta sale por nuestro canal', async () => {
    /*
     * El caso que justifica todo el cambio de motor: la conversación ocurre
     * sobre NUESTRO número, con nuestro contexto, y queda en el mismo hilo que
     * el operador puede tomar. Con NL Pearl el ciudadano estaba en su número y
     * nosotros mirábamos desde afuera.
     */
    const { service, guardadas, enviados } = build({
      operador: { c1: null },
      respuestaAgente: 'Claro, contame en qué te ayudo.',
    });

    await service.process(mensaje('Hola, quiero reportar un bache'), 'gupshup');

    // Los DOS turnos quedan en el hilo: lo que dijo y lo que le contestamos.
    expect(guardadas).toHaveLength(2);
    expect(guardadas[0]).toMatchObject({ direction: 'inbound', summary: 'Hola, quiero reportar un bache' });
    expect(guardadas[1]).toMatchObject({
      direction: 'outbound',
      summary: 'Claro, contame en qué te ayudo.',
      handledBy: 'agente',
    });
    // Y salió de verdad por el canal, dentro de una empresa: un envío sin
    // dueño es un mensaje que no se le puede facturar a nadie.
    expect(enviados).toEqual([
      { contactId: 'nuevo', texto: 'Claro, contame en qué te ayudo.', org: ORG_HISTORICA },
    ]);
  });

  it('el agente NO se mete en un hilo que ya tomó una persona', async () => {
    // Dos voces contestando a la vez es peor que ninguna.
    const { service, guardadas, enviados } = build({
      operador: { c1: 'Jorge Murcia' },
      respuestaAgente: 'Yo contesto',
    });

    await service.process(mensaje('Sí, es en la esquina'), 'gupshup');

    expect(enviados).toHaveLength(0);
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ contactId: 'c1', direction: 'inbound' });
  });

  it('si el agente no contesta, el mensaje igual queda para un humano', async () => {
    const { service, guardadas, enviados, bitacora } = build({
      operador: { c1: null },
      respuestaAgente: '',
    });

    await service.process(mensaje('¿Hay alguien?'), 'gupshup');

    // No se inventa una respuesta...
    expect(enviados).toHaveLength(0);
    // ...pero lo que dijo la persona no se pierde.
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ direction: 'inbound', summary: '¿Hay alguien?' });
    expect(bitacora[0]).toContain('queda para un humano');
  });

  it('no duplica cuando el proveedor reintenta el mismo mensaje', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');
    await service.process(mensaje('Una sola vez', 'repetido'), 'gupshup');

    expect(guardadas).toHaveLength(1);
  });

  it('el número al que escribieron decide qué agente contesta', async () => {
    /*
     * Multi-cliente: el mismo webhook recibe mensajes de líneas distintas.
     * Un mensaje a la app de la clínica lo atiende el agente de la clínica,
     * no el activo global — si esto se rompe, el agente de un cliente le
     * contesta a los ciudadanos de otro.
     */
    const { service, atendidoPor, guardadas } = build({
      operador: {},
      contactos: [],
      respuestaAgente: 'Con gusto, ¿su nombre?',
      lineas: { ClinicaApp: 'ag-clinica' },
    });

    const conApp = { app: 'ClinicaApp', ...mensaje('Quiero una cita') };
    await service.process(conApp, 'gupshup');

    expect(atendidoPor).toEqual(['ag-clinica']);
    // Y el hilo queda atribuido a ESE agente: la bandeja de la clínica lo ve.
    expect(guardadas[0]).toMatchObject({ agente: 'ag-clinica' });
  });

  it('sin línea que coincida, cae al agente activo de siempre', async () => {
    const { service, atendidoPor } = build({
      operador: {},
      contactos: [],
      respuestaAgente: 'Hola',
      lineas: { ClinicaApp: 'ag-clinica' },
    });

    await service.process({ app: 'OtraApp', ...mensaje('Hola', 'm9') }, 'gupshup');

    expect(atendidoPor).toEqual(['ag-1']);
  });

  describe('traspaso entre agentes', () => {
    const DECISION_CAMBIAR = {
      agente: 'ag-obras',
      tema: 'Baches',
      confianza: 100,
      accion: 'cambiar' as const,
    };

    it('contesta el agente NUEVO y el traspaso queda en el hilo', async () => {
      /*
       * Es el punto de todo: el vecino escribe por un bache al agente de
       * aseo y le contesta el de obras, sin repetir nada.
       */
      const { service, atendidoPor, traspasos, guardadas } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'Con gusto, ¿en qué calle?',
        derivacion: { decision: DECISION_CAMBIAR },
      });

      await service.process(mensaje('Hay un bache en la 3ra calle'), 'gupshup');

      expect(atendidoPor).toEqual(['ag-obras']);
      expect(traspasos).toHaveLength(1);

      // Y queda anotado como ACCIÓN, no como un mensaje: quien lea después
      // tiene que ver en qué punto cambió de manos.
      const traspaso = guardadas.find((g) => (g['accion'] as { tipo?: string })?.tipo === 'traspaso');
      expect(traspaso).toBeTruthy();
      expect(traspaso!['agente']).toBe('ag-obras');
    });

    it('el traspaso se PEGA al hilo: el mensaje siguiente no vuelve atrás', async () => {
      /*
       * Sin esto el cambio dura un mensaje y el ciudadano queda rebotando
       * entre dos agentes, repitiendo el caso en cada turno.
       */
      const { service, atendidoPor } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'Listo',
        derivacion: { decision: null, delHilo: 'ag-obras' },
      });

      await service.process(mensaje('¿Y cuándo lo arreglan?', 'm2'), 'gupshup');

      expect(atendidoPor).toEqual(['ag-obras']);
    });

    it('en modo preguntar NO cambia: propone y espera', async () => {
      const { service, atendidoPor, traspasos, propuestas, enviados } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'no debería contestar',
        derivacion: {
          decision: { ...DECISION_CAMBIAR, accion: 'preguntar', confianza: 75 },
        },
      });

      await service.process(mensaje('Hay un bache'), 'gupshup');

      expect(traspasos).toHaveLength(0);
      expect(propuestas).toHaveLength(1);
      // Se mandó la pregunta y NO la respuesta del agente: contestar las dos
      // cosas sería hablarle encima a la persona.
      expect(enviados).toHaveLength(1);
      expect(enviados[0].texto).toMatch(/¿Querés que te pase/);
      expect(atendidoPor).toHaveLength(0);
    });

    it('un «sí» a la propuesta ejecuta el cambio', async () => {
      const { service, atendidoPor, traspasos } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'Contame del bache',
        derivacion: { decision: null, propuesta: { agente: 'ag-obras', tema: 'Baches' } },
      });

      await service.process(mensaje('sí'), 'gupshup');

      expect(traspasos).toHaveLength(1);
      expect(atendidoPor).toEqual(['ag-obras']);
    });

    it('un «no» deja la conversación donde está y no vuelve a insistir', async () => {
      // Insistir con el cambio después de un «no» es lo que molesta de los
      // bots; la propuesta se olvida y contesta quien estaba.
      const { service, atendidoPor, traspasos, propuestas } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'Dale, seguimos',
        derivacion: { decision: null, propuesta: { agente: 'ag-obras', tema: 'Baches' } },
      });

      await service.process(mensaje('no, mejor seguí vos'), 'gupshup');

      expect(traspasos).toHaveLength(0);
      expect(propuestas).toHaveLength(0);
      expect(atendidoPor).toEqual(['ag-1']);
    });

    it('si el traspaso REVIENTA, igual se contesta', async () => {
      /*
       * El traspaso es una mejora sobre contestar. Un error ahí no puede
       * dejar a alguien sin respuesta: contesta quien recibió, que es el
       * comportamiento de siempre.
       */
      const { service, atendidoPor } = build({
        operador: {},
        contactos: [],
        respuestaAgente: 'Buenas, contame',
      });
      // El motor falla en la primera consulta que hace el camino.
      const roto = service as unknown as { derivacion: { agenteDelHilo: () => Promise<string> } };
      roto.derivacion.agenteDelHilo = async () => {
        throw new Error('config caída');
      };

      await service.process(mensaje('Hay un bache'), 'gupshup');

      expect(atendidoPor).toEqual(['ag-1']);
    });
  });

  /*
   * De quién es lo que entra por el webhook.
   *
   * Un webhook no trae sesión: el proveedor no sabe que existen nuestras
   * empresas. Sin fijar la empresa de la línea, todo lo que entra se guarda
   * sin dueño —invisible en la consola del cliente— y los mensajes que el
   * agente contesta no se le pueden facturar a nadie. Es la diferencia
   * entre un SaaS multi-cliente y una base compartida.
   */
  describe('A qué empresa pertenece lo que entra', () => {
    it('lo guardado y lo enviado quedan DENTRO de la empresa de la línea', async () => {
      const { service, guardadas, enviados } = build({
        operador: {},
        respuestaAgente: 'Listo, queda registrado.',
        lineas: { 'app-clinica': 'ag-clinica' },
        duenas: { 'app-clinica': 'org-clinica' },
      });

      await service.process(
        {
          type: 'message',
          payload: { id: 'm-1', type: 'text', source: '+50499998888', payload: { text: 'Hola' } },
          app: 'app-clinica',
        },
        'gupshup',
      );

      expect(guardadas.length).toBeGreaterThan(0);
      for (const g of guardadas) expect(g['__org']).toBe('org-clinica');
      expect(enviados[0].org).toBe('org-clinica');
    });

    it('dos líneas de empresas distintas no se mezclan', async () => {
      // Es LA propiedad del multi-cliente: el mismo webhook recibe mensajes
      // de clientes que no deben verse entre sí.
      const { service, guardadas } = build({
        operador: {},
        respuestaAgente: 'Listo.',
        lineas: { 'app-clinica': 'ag-clinica', 'app-taller': 'ag-taller' },
        duenas: { 'app-clinica': 'org-clinica', 'app-taller': 'org-taller' },
      });

      for (const [app, tel] of [
        ['app-clinica', '+50499998888'],
        ['app-taller', '+50477776666'],
      ]) {
        await service.process(
          {
            type: 'message',
            payload: { id: `m-${app}`, type: 'text', source: tel, payload: { text: 'Hola' } },
            app,
          },
          'gupshup',
        );
      }

      const orgs = new Set(guardadas.map((g) => g['__org']));
      expect(orgs).toEqual(new Set(['org-clinica', 'org-taller']));
    });

    it('el número histórico, sin línea dada de alta, cae en la organización histórica', async () => {
      /*
       * La Línea 100 atiende desde antes de que existieran las empresas. Si
       * cayera en «ninguna», sus mensajes se guardarían sin dueño y
       * desaparecerían de la consola que los viene mostrando hace meses.
       */
      const { service, guardadas } = build({
        operador: {},
        respuestaAgente: 'Listo.',
      });

      await service.process(
        {
          type: 'message',
          payload: { id: 'm-viejo', type: 'text', source: '+50497616546', payload: { text: 'Hola' } },
          app: 'app-sin-dar-de-alta',
        },
        'gupshup',
      );

      expect(guardadas.length).toBeGreaterThan(0);
      for (const g of guardadas) expect(g['__org']).toBe(ORG_HISTORICA);
    });
  });

  it('un acuse de entrega no es un mensaje del ciudadano', async () => {
    const { service, guardadas } = build({ operador: { c1: 'Jorge Murcia' } });

    await service.process(
      { type: 'message-event', payload: { type: 'delivered', destination: TEL, payload: {} } },
      'gupshup',
    );

    expect(guardadas).toHaveLength(0);
  });
});
