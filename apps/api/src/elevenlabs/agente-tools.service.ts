import { Inject, Injectable, Logger } from '@nestjs/common';
import { BrainService } from '../brain/brain.service';
import { HubspotClient } from '../hubspot/hubspot.client';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { SettingsService } from '../shared/settings.service';

/** Lo que se le devuelve al agente para que siga la conversación. */
export interface ResultadoHerramienta {
  ok: boolean;
  /** Texto corto que el agente puede leerle al ciudadano (el folio, el error). */
  mensaje: string;
}

/**
 * Lo que el agente PUEDE HACER, además de conversar.
 *
 * Son las herramientas que declara en ElevenLabs: cuando decide usarlas, nos
 * llega un `client_tool_call` por el WebSocket, se ejecutan acá y el
 * resultado vuelve para que el agente lo cuente.
 *
 * Cada ejecución deja una interacción en el hilo con `accion`, y ese es el
 * punto: el operador ve EN EL CHAT, entre los mensajes, que el reporte de un
 * derrumbe abrió un ticket y disparó el aviso — y en qué momento de la
 * conversación pasó. Guardarlo en un log aparte lo volvería un registro que
 * nadie mira.
 *
 * Con NL Pearl estas acciones las disparaba su flujo contra `/notificar`;
 * ahora las decide el agente y las ejecutamos nosotros, que es lo que nos
 * deja cambiar de motor sin perder el CRM ni los avisos.
 */
@Injectable()
export class AgenteToolsService {
  private readonly logger = new Logger(AgenteToolsService.name);

  /**
   * A quién se le avisa. Es el mismo número que ya usaba el aviso de
   * emergencia del flujo de NL Pearl.
   */
  private static readonly CUADRILLA = '+50498288272';

  constructor(
    private readonly brain: BrainService,
    private readonly hubspot: HubspotClient,
    private readonly settings: SettingsService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
  ) {}

  /** Los nombres tal como hay que declararlos en el agente de ElevenLabs. */
  static readonly NOMBRES = [
    'registrar_reporte',
    'avisar_autoridad',
    'asignar_tarea',
    'escalar_a_humano',
    'actualizar_ficha',
  ] as const;

  /** HubSpot solo acepta estas tres; el agente manda texto libre. */
  private static prioridadValida(valor: string): 'LOW' | 'MEDIUM' | 'HIGH' {
    return (['LOW', 'MEDIUM', 'HIGH'].includes(valor) ? valor : 'HIGH') as 'LOW' | 'MEDIUM' | 'HIGH';
  }

  /**
   * Los campos del riel derecho, en el orden en que se dibujan.
   *
   * Es una lista cerrada a propósito: si el agente inventa un campo, se
   * descarta. Un panel donde el modelo puede agregar filas se convierte en un
   * volcado de lo que se le ocurrió esa vez, y deja de leerse de un vistazo.
   */
  static readonly CAMPOS_FICHA = [
    'tipo_problema',
    'ubicacion',
    'descripcion',
    'riesgo',
    'afectados',
    'estado',
    'proximo_paso',
  ] as const;

  /**
   * Ejecuta la herramienta que pidió el agente.
   *
   * Nunca lanza: si algo falla, el agente recibe el motivo y puede decírselo
   * al ciudadano en vez de quedarse mudo. Un error del CRM no puede cortar la
   * conversación.
   */
  async ejecutar(
    contactId: string,
    nombre: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    try {
      let resultado: ResultadoHerramienta;
      switch (nombre) {
        case 'registrar_reporte':
          resultado = await this.registrarReporte(contactId, args);
          break;
        case 'avisar_autoridad':
          resultado = await this.avisarAutoridad(contactId, args);
          break;
        case 'asignar_tarea':
          resultado = await this.asignarTarea(contactId, args);
          break;
        case 'escalar_a_humano':
          resultado = await this.escalarAHumano(contactId, args);
          break;
        case 'actualizar_ficha':
          return await this.actualizarFicha(contactId, args);
        default:
          this.logger.warn(`El agente pidió una herramienta que no existe: "${nombre}"`);
          return { ok: false, mensaje: `No existe la herramienta "${nombre}".` };
      }

      /*
       * La ficha del riel también se llena SOLA con lo que la herramienta acaba
       * de hacer.
       *
       * Depender de que el agente llame `actualizar_ficha` funciona en la
       * conversación tranquila y falla justo cuando importa: probado contra el
       * agente real, ante "hay una señora atrapada" avisó a la cuadrilla —bien—
       * pero no tocó la ficha, así que el riesgo seguía diciendo "medio" en la
       * pantalla del operador que tiene que decidir si entra.
       *
       * Los datos siguen siendo del agente: salen de los argumentos con los que
       * él mismo llamó la herramienta. Lo que ya no depende de él es acordarse
       * de anotarlos.
       */
      if (resultado.ok) await this.fichaDesde(contactId, nombre, args);
      return resultado;
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`Falló la herramienta "${nombre}": ${motivo}`);
      await this.anotar(contactId, 'ticket', false, `No se pudo ejecutar "${nombre}": ${motivo}`);
      return { ok: false, mensaje: `No se pudo completar la acción: ${motivo}` };
    }
  }

  /** Abre el ticket en el CRM y devuelve el folio para que el agente lo diga. */
  private async registrarReporte(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const tipo = String(args['tipo_problema'] ?? '').trim();
    const ubicacion = String(args['ubicacion'] ?? '').trim();
    const descripcion = String(args['descripcion'] ?? '').trim();

    // El agente puede equivocarse y llamar sin los datos. Se le dice qué
    // falta para que lo pregunte, en vez de abrir un ticket inservible.
    const faltan = [
      !tipo && 'el tipo de problema',
      !ubicacion && 'la ubicación',
      !descripcion && 'la descripción',
    ].filter(Boolean) as string[];
    if (faltan.length) {
      return { ok: false, mensaje: `Todavía falta ${faltan.join(', ')}. Preguntalo antes de registrar.` };
    }

    if (!this.hubspot.configured) {
      await this.anotar(contactId, 'ticket', false, `${tipo} en ${ubicacion} — el CRM no está conectado`);
      return {
        ok: false,
        mensaje: 'El CRM no está conectado, así que no hay folio. Decile que su reporte quedó anotado igual.',
      };
    }

    const ctx = await this.brain.getContext({ contactId });
    const telefono = ctx.contact.phones?.[0];

    const { id } = await this.hubspot.crearTicket(
      {
        subject: `${tipo} · ${ubicacion}`,
        content: [descripcion, `Reporta: ${ctx.contact.displayName ?? 'ciudadano'} (${telefono ?? 's/n'})`]
          .filter(Boolean)
          .join('\n\n'),
      },
      telefono,
    );

    const folio = `AMDC-${id}`;
    await this.anotar(contactId, 'ticket', true, `${tipo} en ${ubicacion} · folio ${folio}`);
    this.logger.log(`El agente abrió el ticket ${folio} para ${contactId}`);

    /*
     * El reporte se convierte en trabajo de alguien acá mismo.
     *
     * Depender de que el agente llame `asignar_tarea` no funciona: probado
     * contra el agente real, registró el bache, le dijo al ciudadano "lo
     * trasladamos a la cuadrilla de bacheo" y NO creó ninguna tarea — su
     * propio plan decía asignarla. Es la misma promesa sin mecanismo que ya
     * habíamos visto con el escalamiento.
     *
     * Nace sin dueño porque nadie acá sabe a quién le toca un bache en la
     * Kennedy: eso lo pone `asignar_tarea` después, sobre ESTA misma tarea.
     * Una tarea sin dueño se ve en el CRM y se puede repartir; una que no
     * existe, no.
     */
    await this.tareaDelReporte(contactId, `Atender: ${tipo} en ${ubicacion}`, descripcion, telefono);

    return { ok: true, mensaje: `Reporte registrado con el folio ${folio}. Decíselo al ciudadano.` };
  }

  /**
   * Crea la tarea del reporte y la deja anotada para poder asignarla después.
   *
   * No lanza: el ticket YA se abrió y el ciudadano ya tiene su folio. Quedarse
   * sin tarea es un problema del equipo; tirar el turno por eso sería un
   * problema del vecino.
   */
  private async tareaDelReporte(
    contactId: string,
    titulo: string,
    detalle: string,
    telefono?: string,
  ): Promise<void> {
    try {
      const { id } = await this.hubspot.crearTarea({
        titulo,
        detalle,
        contactoId: await this.contactoEnCrm(telefono),
      });
      // Para que `asignar_tarea` le ponga dueño a esta en vez de crear otra.
      await this.settings.set(`tarea:${contactId}`, id);
      await this.anotar(contactId, 'ticket', true, `${titulo} — tarea creada, sin responsable todavía`);
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`No se pudo crear la tarea del reporte: ${motivo}`);
      await this.anotar(contactId, 'ticket', false, `${titulo} — no se pudo crear la tarea: ${motivo}`);
    }
  }

  /**
   * Avisa a la cuadrilla por WhatsApp. Es el canal que tenemos a mano y que
   * ya se usaba para las emergencias del flujo anterior.
   */
  private async avisarAutoridad(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const motivo = String(args['motivo'] ?? '').trim();
    const ubicacion = String(args['ubicacion'] ?? '').trim();
    if (!motivo || !ubicacion) {
      return { ok: false, mensaje: 'Para avisar hace falta el motivo y la ubicación.' };
    }

    const ctx = await this.brain.getContext({ contactId });
    const texto = [
      '🚨 Línea 100 · aviso',
      motivo,
      `Ubicación: ${ubicacion}`,
      args['detalle'] ? `Detalle: ${String(args['detalle'])}` : null,
      `Reporta: ${ctx.contact.displayName ?? 'ciudadano'} (${ctx.contact.phones?.[0] ?? 's/n'})`,
      'Avisa: el agente de la Línea 100.',
    ]
      .filter(Boolean)
      .join('\n');

    const { contactId: destino } = await this.brain.resolveIdentity({
      phone: AgenteToolsService.CUADRILLA,
      displayName: 'Cuadrilla de emergencia',
    });
    await this.whatsapp.send(destino, texto);

    await this.anotar(contactId, 'aviso', true, `${motivo} en ${ubicacion} — avisado a la cuadrilla`);
    this.logger.log(`El agente avisó a la cuadrilla por ${contactId}: ${motivo}`);

    return { ok: true, mensaje: 'Ya se avisó a la cuadrilla. Decile al ciudadano que va en camino el aviso.' };
  }

  /**
   * Le asigna la tarea a quien corresponde, en el CRM.
   *
   * Es lo que convierte un reporte en trabajo de alguien: el ticket dice qué
   * pasó, la tarea dice quién lo atiende. El agente elige al responsable de
   * la lista real del portal — no de una lista inventada acá— y si se
   * equivoca con el nombre se le devuelven los que existen para que reintente.
   */
  private async asignarTarea(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const titulo = String(args['titulo'] ?? '').trim();
    const responsable = String(args['responsable'] ?? '').trim();
    if (!titulo) return { ok: false, mensaje: 'La tarea necesita un título.' };

    if (!this.hubspot.configured) {
      await this.anotar(contactId, 'ticket', false, `${titulo} — el CRM no está conectado`);
      return { ok: false, mensaje: 'El CRM no está conectado, así que no se pudo asignar la tarea.' };
    }

    const gente = await this.hubspot.responsables();
    const elegido = AgenteToolsService.buscarResponsable(gente, responsable);
    const lista = () =>
      gente.map((o) => AgenteToolsService.nombreDe(o)).filter(Boolean).slice(0, 12).join(', ');

    if (responsable && !elegido) {
      // Se le devuelve la lista real en vez de asignarle a cualquiera: una
      // tarea en la bandeja equivocada es peor que una sin dueño.
      return {
        ok: false,
        mensaje: `No encontré a "${responsable}". Los responsables disponibles son: ${lista()}.`,
      };
    }

    const ctx = await this.brain.getContext({ contactId });
    const tipo = String(args['tipo'] ?? 'TODO').toUpperCase();
    const prioridad = String(args['prioridad'] ?? 'HIGH').toUpperCase();

    /*
     * Registrar el reporte ya dejó una tarea sin dueño. Si esa sigue ahí, se le
     * pone responsable en vez de crear una segunda: el equipo vería dos tarjetas
     * para el mismo bache y una de ellas sin nadie, que es peor que el problema
     * original.
     */
    const pendiente = await this.settings.get<string>(`tarea:${contactId}`);
    if (pendiente && !elegido) {
      /*
       * Probado contra el agente real: llama esta herramienta SIN responsable,
       * porque no tiene de dónde sacar la lista hasta que se la damos. Sin este
       * corte caía a crear otra tarea y quedaban dos para el mismo bache.
       */
      return {
        ok: false,
        mensaje: `La tarea ya está creada; lo único que falta es el responsable. Volvé a llamarme con uno de estos: ${lista()}.`,
      };
    }
    if (pendiente && elegido) {
      await this.hubspot.asignarTarea(pendiente, elegido.id, AgenteToolsService.prioridadValida(prioridad));
      await this.settings.set(`tarea:${contactId}`, '');
      const aQuien = AgenteToolsService.nombreDe(elegido);
      await this.anotar(contactId, 'ticket', true, `Tarea "${titulo}" → ${aQuien}`);
      this.logger.log(`El agente asignó la tarea del reporte a ${aQuien}`);
      return { ok: true, mensaje: `Tarea asignada a ${aQuien}. Decile al ciudadano que ya tiene responsable.` };
    }

    const { id } = await this.hubspot.crearTarea({
      titulo,
      detalle: [
        String(args['detalle'] ?? '').trim(),
        `Reporta: ${ctx.contact.displayName ?? 'ciudadano'} (${ctx.contact.phones?.[0] ?? 's/n'})`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      tipo: (['EMAIL', 'CALL', 'TODO'].includes(tipo) ? tipo : 'TODO') as 'EMAIL' | 'CALL' | 'TODO',
      prioridad: AgenteToolsService.prioridadValida(prioridad),
      ownerId: elegido?.id,
      contactoId: await this.contactoEnCrm(ctx.contact.phones?.[0]),
    });

    const aQuien = elegido ? AgenteToolsService.nombreDe(elegido) : 'sin asignar';
    await this.anotar(contactId, 'ticket', true, `Tarea "${titulo}" → ${aQuien} (#${id})`);
    this.logger.log(`El agente asignó "${titulo}" a ${aQuien}`);

    return {
      ok: true,
      mensaje: elegido
        ? `Tarea asignada a ${aQuien}. Decile al ciudadano que ya tiene responsable.`
        : 'Tarea creada, pero sin responsable asignado.',
    };
  }

  /**
   * Pide que una persona tome el hilo.
   *
   * Existe porque el agente estaba PROMETIENDO una transferencia que no
   * ocurría: le decía al ciudadano "te paso con un operador" y ahí terminaba
   * todo. Ahora la promesa tiene un mecanismo detrás — el hilo queda marcado,
   * la consola lo muestra y suena — así que lo que dice se cumple.
   *
   * No corta la conversación: el agente sigue contestando hasta que alguien
   * la tome de verdad. Dejar al ciudadano hablando solo mientras espera sería
   * peor que no escalar.
   */
  private async escalarAHumano(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const motivo = String(args['motivo'] ?? '').trim() || 'El ciudadano necesita hablar con una persona';
    const urgente = String(args['urgencia'] ?? '').toLowerCase().includes('alta');

    await this.anotar(contactId, 'escalamiento', true, motivo);
    this.logger.warn(`Escalamiento a humano en ${contactId}: ${motivo}`);

    return {
      ok: true,
      mensaje: urgente
        ? 'Ya avisé al equipo con prioridad alta. Decile que seguís con él mientras alguien entra a la conversación, y NO le pidas que espere en la línea: esto es un chat, no una llamada.'
        : 'Ya avisé al equipo. Decile que alguien va a entrar a esta misma conversación, y seguí ayudándolo mientras tanto.',
    };
  }

  /**
   * Lo que el agente entendió, mientras lo va entendiendo.
   *
   * El riel derecho mostraba el avance que reportaba el flujo de NL Pearl, que
   * con este agente no llega nunca: quedaba un panel muerto. Ahora lo llena el
   * propio agente y el operador ve el caso armarse en vivo, sin leer el hilo
   * entero — que es lo que hace cuando tiene que decidir si entra.
   *
   * Se guarda solo lo que viene: cada llamada es un parcial y la consola los
   * acumula. Si el agente reenviara la ficha entera en cada turno, todos los
   * campos parecerían recién cambiados y el resaltado dejaría de significar
   * algo.
   */
  private async actualizarFicha(
    contactId: string,
    args: Record<string, unknown>,
  ): Promise<ResultadoHerramienta> {
    const ficha: Record<string, string> = {};
    for (const campo of AgenteToolsService.CAMPOS_FICHA) {
      const valor = String(args[campo] ?? '').trim();
      if (valor) ficha[campo] = valor;
    }

    if (!Object.keys(ficha).length) {
      return { ok: false, mensaje: 'No mandaste ningún dato para la ficha.' };
    }

    await this.brain
      .appendInteraction({
        contactId,
        channel: 'note',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: `Ficha actualizada: ${Object.keys(ficha).join(', ')}`,
        source: 'own',
        handledBy: 'agente',
        ficha,
      })
      .catch((err) => {
        this.logger.warn(`No se pudo guardar la ficha: ${(err as Error).message}`);
      });

    /*
     * La respuesta es corta y no lo felicita: si le devolvemos algo con
     * sustancia, el agente tiende a contárselo al ciudadano ("ya anoté la
     * ubicación"), y esto es un panel interno que el vecino no ve.
     */
    return { ok: true, mensaje: 'Ficha actualizada. No se lo menciones al ciudadano; seguí la conversación.' };
  }

  /**
   * Lo que una acción dice sobre el caso, sin preguntarle al agente.
   *
   * Avisar a la cuadrilla ES riesgo alto: nadie la manda por un bache. Abrir el
   * ticket ES que el caso quedó registrado. Son deducciones del hecho, no
   * interpretaciones, así que se pueden escribir sin consultar al modelo.
   *
   * Solo se escriben campos que la acción determina de verdad. `descripcion`
   * sale del reporte porque ahí el agente ya la redactó; del aviso no, porque
   * su `detalle` está escrito para la cuadrilla y no para el panel.
   */
  private async fichaDesde(
    contactId: string,
    herramienta: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const texto = (clave: string) => String(args[clave] ?? '').trim() || undefined;
    const ficha: Record<string, string | undefined> = {};

    switch (herramienta) {
      case 'registrar_reporte':
        ficha.tipo_problema = texto('tipo_problema');
        ficha.ubicacion = texto('ubicacion');
        ficha.descripcion = texto('descripcion');
        ficha.estado = 'registrado';
        break;
      case 'avisar_autoridad':
        ficha.ubicacion = texto('ubicacion');
        ficha.riesgo = 'alto';
        ficha.afectados = texto('detalle');
        ficha.estado = 'cuadrilla avisada';
        break;
      case 'asignar_tarea':
        ficha.proximo_paso = texto('titulo');
        break;
      case 'escalar_a_humano':
        ficha.riesgo = String(args['urgencia'] ?? '').toLowerCase().includes('alta') ? 'alto' : undefined;
        ficha.estado = 'escalado';
        ficha.proximo_paso = 'Espera que un operador entre a la conversación';
        break;
      default:
        return;
    }

    const limpia = Object.fromEntries(
      Object.entries(ficha).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    if (!Object.keys(limpia).length) return;

    await this.actualizarFicha(contactId, limpia);
  }

  /**
   * El id del contacto en HubSpot, para colgarle la tarea a su ficha.
   *
   * Si no está en el CRM la tarea se crea igual, suelta: perder la asociación
   * es molesto, no tener la tarea es peor.
   */
  private async contactoEnCrm(telefono?: string): Promise<string | undefined> {
    if (!telefono) return undefined;
    try {
      const [id] = await this.hubspot.contactosPorTelefono(telefono);
      return id;
    } catch {
      return undefined;
    }
  }

  /** Por email exacto o por nombre, sin distinguir mayúsculas ni acentos. */
  private static buscarResponsable(
    gente: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>,
    buscado: string,
  ) {
    if (!buscado) return undefined;
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim();
    const q = norm(buscado);
    return (
      gente.find((o) => norm(o.email ?? '') === q) ??
      gente.find((o) => norm(AgenteToolsService.nombreDe(o)).includes(q)) ??
      gente.find((o) => q.includes(norm(o.firstName ?? '__')))
    );
  }

  private static nombreDe(o: { email?: string; firstName?: string; lastName?: string }): string {
    return [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || (o.email ?? '');
  }

  /**
   * Deja la acción EN EL HILO, no en un log aparte.
   *
   * `channel: 'note'` porque no es un mensaje que el ciudadano reciba, y
   * `accion` es lo que hace que la consola la dibuje como acción y no como
   * un apunte del equipo.
   */
  private async anotar(
    contactId: string,
    tipo: 'ticket' | 'aviso' | 'escalamiento',
    ok: boolean,
    detalle: string,
  ): Promise<void> {
    await this.brain
      .appendInteraction({
        contactId,
        channel: 'note',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: detalle,
        source: 'own',
        handledBy: 'agente',
        accion: { tipo, ok, detalle },
      })
      .catch((err) => {
        // La acción YA se hizo; no poder anotarla no la deshace.
        this.logger.warn(`No se pudo anotar la acción en el hilo: ${(err as Error).message}`);
      });
  }
}
