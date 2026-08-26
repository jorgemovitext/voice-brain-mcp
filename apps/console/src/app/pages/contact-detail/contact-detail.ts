import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { BrainApiService } from '../../brain-api.service';
import { Icon } from '../../icon';
import { VoiceNebula } from '../../nebula';
import { crearSondeo } from '../../sondeo';
import { Sonido } from '../../sonido';
import {
  AvanceFlujo,
  AccionSugerida,
  Expediente,
  ContactListItem,
  FlujoEnCurso,
  Interaction,
  Sentiment,
  Signal as BrainSignal,
  UnifiedContext,
} from '../../models';
import {
  channelColor,
  channelIconName,
  channelLabel,
  kycmLabel,
  sentimentClass,
  sentimentLabel,
} from '../../ui';
import { hexAlargado, romboRedondo } from '../../hex';

/** Mensaje del hilo, listo para pintar como burbuja. */
interface ChatItem {
  interaction: Interaction;
  side: 'in' | 'out';
  dayLabel: string | null; // separador de día (solo en el primer msg del día)
  time: string;
  /** Primero de una tanda del mismo lado: lleva la esquina marcada. */
  abreGrupo: boolean;
  /** Último de la tanda: lleva el avatar y la hora. */
  cierraGrupo: boolean;
}

type CallState = 'idle' | 'calling' | 'ended';

/** Paleta pastel para tiles (misma que en el directorio). */
const TILE_COLORS = ['#ffd9c8', '#cdeffd', '#ffe9a8', '#f3d1ff', '#c8f7d0', '#d7dbff', '#ffd6e7', '#d2f4ee'];

/**
 * Chat del contacto + panel "Contexto en vivo" (avatar de voz, estado
 * emocional, caso, resumen de IA, momentos clave y acciones).
 *
 * Se usa en dos rutas:
 *  - /contacts/:id       → 2 columnas (chat + contexto), al entrar desde el directorio
 *  - /conversations/:id  → 3 columnas: agrega el sidebar de hilos (withThreads),
 *                          el módulo de Conversaciones para alternar entre chats
 */
@Component({
  selector: 'app-contact-detail',
  imports: [RouterLink, VoiceNebula, Icon],
  templateUrl: './contact-detail.html',
  styleUrl: './contact-detail.scss',
})
export class ContactDetailPage implements OnDestroy {
  /** :id de la ruta (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly api = inject(BrainApiService);
  private readonly sonido = inject(Sonido);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  /** El primer render siempre baja al final aunque el hilo sea largo. */
  private primerRender = true;

  /**
   * true solo en /conversations/:id → muestra el sidebar de hilos.
   * Se lee de route.data (no de un @Input) para que el valor sea correcto
   * aunque el router reutilice la instancia entre ambas rutas.
   */
  readonly withThreads = toSignal(
    this.route.data.pipe(map((data) => !!data['withThreads'])),
    { initialValue: !!this.route.snapshot.data['withThreads'] },
  );

  private timerInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private callStartedAt = 0;

  readonly context = httpResource<UnifiedContext>(() => `/api/contacts/${this.id()}/context`);
  /** Lista de hilos del sidebar; solo se pide en el módulo de Conversaciones. */
  readonly conversations = httpResource<ContactListItem[]>(() =>
    this.withThreads() ? '/api/contacts' : undefined,
  );

  /**
   * Teléfonos con conversación abierta, para ordenar y marcar el sidebar. Un
   * hilo que está abriéndose no tiene mensajes y sin esto caía al fondo.
   */
  private readonly flujoAbierto = httpResource<FlujoEnCurso[]>(() =>
    this.withThreads() ? '/api/nlpearl/en-curso' : undefined,
  );

  private readonly enCurso = computed(
    () => new Map((this.flujoAbierto.value() ?? []).map((f) => [f.phone, f])),
  );

  /**
   * Teléfono del contacto, aislado en su propio `computed`.
   *
   * Parece un rodeo pero no lo es: `context.value()` devuelve un objeto nuevo
   * en cada refresco, y leerlo directo desde el httpResource de abajo lo hacía
   * re-pedir en cada vuelta del sondeo — se midieron 189 peticiones en 5
   * minutos. Con el teléfono suelto, la identidad es un string y solo cambia
   * cuando cambia de verdad.
   */
  private readonly telefono = computed(() => this.context.value()?.contact.phones?.[0]);

  /**
   * Avances que el flujo de la Pearl empuja DURANTE la conversación. No son
   * mensajes: NL Pearl no expone el texto de los turnos en vivo, solo las
   * variables que va recopilando. Se piden por teléfono porque así los
   * identifica el nodo del flujo.
   */
  readonly progreso = httpResource<AvanceFlujo[]>(() => {
    const tel = this.telefono();
    return tel ? `/api/nlpearl/progress?phone=${encodeURIComponent(tel)}` : undefined;
  });

  /** El acumulado del flujo → solo lo que aporta cada paso. */
  private static conDeltas(
    ordenados: AvanceFlujo[],
  ): Array<AvanceFlujo & { nuevos: Array<{ clave: string; valor: string }> }> {
    const visto = new Map<string, string>();
    return ordenados.map((a) => {
      const nuevos: Array<{ clave: string; valor: string }> = [];
      for (const [clave, valor] of Object.entries(a.datos ?? {})) {
        const texto = (typeof valor === 'string' ? valor : JSON.stringify(valor) ?? '').trim();
        if (!texto || visto.get(clave) === texto) continue;
        visto.set(clave, texto);
        nuevos.push({ clave, valor: texto });
      }
      return { ...a, nuevos };
    });
  }

  /**
   * Los hitos del CASO ACTUAL (la conversación más reciente). Alimenta las
   * DOS líneas de tiempo: la del panel de contexto y la de la vista Caso.
   *
   * El endpoint devuelve los avances de todo el teléfono, y el mismo número
   * reporta varias veces. El panel los mostraba todos y la vista Caso solo
   * los de esta conversación, así que el mismo caso se contaba dos veces con
   * distinto largo. La marca de escalamiento no lleva conversationId y se
   * incluye igual — pertenece al incidente, no al hilo.
   *
   * Cada hito trae SOLO lo que aporta: el flujo empuja el acumulado completo
   * en cada avance, y pintarlo tal cual repetía todo lo anterior.
   */
  /**
   * El id de la conversación que está corriendo AHORA: la más reciente entre
   * los avances del flujo.
   */
  readonly conversacionActual = computed(() => {
    const orden = [...(this.progreso.value() ?? [])].sort((a, b) =>
      (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''),
    );
    return [...orden].reverse().find((a) => a.conversationId)?.conversationId ?? null;
  });

  /**
   * Los mensajes que pertenecen a ESA conversación, no al contacto entero.
   *
   * Es la corrección de un bug de fondo: todo lo "en vivo" se decidía con
   * `chat().length`, que son todos los mensajes históricos del número. Un
   * ciudadano que ya había escrito antes nunca volvía a mostrar flujo en
   * curso — el caso nuevo nacía marcado como "conversación completa" y sin
   * nodo actual.
   *
   * El vínculo es el id: la ingesta guarda cada turno como
   * `nlpearl:{conversationId}:{n}`.
   */
  readonly mensajesDelCaso = computed(() => {
    const id = this.conversacionActual();
    if (!id) return this.chat();
    const prefijo = `nlpearl:${id}:`;
    return this.chat().filter((m) => m.interaction.id.startsWith(prefijo));
  });

  /** El caso está corriendo: hay avances y todavía ningún mensaje suyo. */
  readonly casoEnCurso = computed(() => this.hitos().length > 0 && this.mensajesDelCaso().length === 0);

  readonly hitos = computed(() => {
    const orden = [...(this.progreso.value() ?? [])].sort((a, b) =>
      (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''),
    );
    const ultima = [...orden].reverse().find((a) => a.conversationId)?.conversationId;
    const delCaso = ultima ? orden.filter((a) => a.conversationId === ultima || !a.conversationId) : orden;
    return ContactDetailPage.conDeltas(delCaso);
  });

  /**
   * Qué mostrar en el cuerpo del panel: el chat, el CASO (qué datos capturó
   * el flujo) o el FLUJO (por qué nodos pasó el agente, uno tras otro).
   *
   * `null` = automático: mientras no hay mensajes —la conversación entera
   * puede tardar en llegar— lo único vivo son los avances, y el recorrido
   * del flujo es lo que se muestra en lugar del chat vacío; en cuanto hay
   * mensajes, el chat pasa al frente solo. El tab fija la elección manual,
   * y cambiar de hilo la borra.
   */
  readonly vista = signal<'chat' | 'flujo' | 'ruta' | null>(null);
  readonly vistaActiva = computed(() => this.vista() ?? (this.mensajesDelCaso().length ? 'chat' : 'ruta'));

  /** Estado del caso para la cabecera del diagrama. */
  readonly estadoCaso = computed<{ clase: string; texto: string }>(() => {
    // El escalamiento manda aunque la conversación ya haya cerrado: es el
    // estado del CASO, no el de la charla.
    if (this.hitos().some((a) => a.paso === 'escalamiento'))
      return { clase: 'escala', texto: 'Escalado al despacho' };
    if (this.mensajesDelCaso().length) return { clase: 'fin', texto: 'Conversación completa' };
    if (this.hitos().length) return { clase: 'vivo', texto: 'Conversación en curso' };
    return { clase: 'espera', texto: 'Esperando al agente' };
  });

  /**
   * La ruta que el flujo del agente recorre para registrar un reporte. Sirve
   * para dibujar los pasos PENDIENTES en tenue: el diagrama muestra a dónde
   * va el caso, no solo por dónde pasó. Las `claves` cubren los nombres de
   * nodo de ambas ramas (normal y de emergencia: collectLocation, emApiLoc…).
   */
  private static readonly RUTA: Array<{ paso: string; etiqueta: string; claves: string[] }> = [
    { paso: 'collectProblem', etiqueta: 'Tipo de problema', claves: ['problem'] },
    { paso: 'collectLocation', etiqueta: 'Ubicación', claves: ['loc', 'ubic', 'geocode'] },
    { paso: 'collectDesc', etiqueta: 'Descripción', claves: ['desc'] },
    { paso: 'collectContact', etiqueta: 'Datos de contacto', claves: ['cont'] },
    { paso: 'confirmInfo', etiqueta: 'Confirmación', claves: ['confirm'] },
    { paso: 'registered', etiqueta: 'Reporte registrado', claves: ['regist'] },
  ];

  /*
   * ===== El árbol del flujo =====
   *
   * No es un adorno: cada nodo y cada bifurcación existen en el flujo real de
   * la Pearl "Línea 100 AMDC Whatsapp". `safetyCheck` abre de verdad en tres
   * ("Hay peligro inmediato" / "No hay peligro, ciudadano tiene reporte" /
   * "Ciudadano pide hablar con persona"), y `confirmInfo` y `checkEscalamiento`
   * en dos. Dibujar el árbol completo (58 nodos) sería ilegible, así que está
   * la columna vertebral con sus cuatro decisiones.
   *
   * `col` es la columna (-1 izquierda, 0 centro, 1 derecha) y `fila` la
   * altura: con eso se calculan las coordenadas del SVG y las curvas.
   */
  private static readonly MAPA: Array<{
    id: string;
    etiqueta: string;
    fila: number;
    col: number;
    /** Rombo en vez de hexágono: es un punto donde el flujo elige. */
    decision?: boolean;
    /** Trozos de nombre de paso que marcan este nodo como recorrido. */
    claves?: string[];
    /** De qué decisión cuelga, para saber si quedó descartado. */
    padre?: string;
  }> = [
    { id: 'saludo', etiqueta: 'Saludo', fila: 0, col: 0, claves: ['opening', 'greet'] },
    { id: 'peligro', etiqueta: '¿Hay peligro?', fila: 1, col: 0, decision: true },
    { id: 'emergencia', etiqueta: 'Emergencia', fila: 2, col: -1, claves: ['emergen'], padre: 'peligro' },
    { id: 'reporte', etiqueta: 'Reporte', fila: 2, col: 1, claves: ['problem', 'identif'], padre: 'peligro' },
    { id: 'ubicacion', etiqueta: 'Ubicación', fila: 3, col: 0, claves: ['loc', 'ubic', 'geocode'] },
    { id: 'cobertura', etiqueta: '¿En cobertura?', fila: 4, col: 0, decision: true },
    { id: 'fuera', etiqueta: 'Fuera del área', fila: 5, col: -1, claves: ['fuera', 'coverage'], padre: 'cobertura' },
    { id: 'detalle', etiqueta: 'Detalle y foto', fila: 5, col: 1, claves: ['desc', 'detail', 'photo', 'foto'], padre: 'cobertura' },
    { id: 'contacto', etiqueta: 'Contacto', fila: 6, col: 0, claves: ['cont'] },
    { id: 'confirma', etiqueta: '¿Confirma?', fila: 7, col: 0, decision: true },
    { id: 'corregir', etiqueta: 'Corregir', fila: 8, col: -1, claves: ['correg'], padre: 'confirma' },
    { id: 'ticket', etiqueta: 'Reporte registrado', fila: 8, col: 1, claves: ['regist', 'ticket'], padre: 'confirma' },
    { id: 'escala', etiqueta: '¿Escala?', fila: 9, col: 0, decision: true },
    { id: 'despacho', etiqueta: 'Al despacho', fila: 10, col: -1, claves: ['escalamiento', 'alcalde'], padre: 'escala' },
    { id: 'cierre', etiqueta: 'Cierre', fila: 10, col: 1, claves: ['farewell', 'closing', 'endcall'], padre: 'escala' },
  ];

  /** Las aristas del árbol, con la etiqueta de la rama cuando decide algo. */
  private static readonly ARISTAS: Array<{ de: string; a: string; ramo?: string }> = [
    { de: 'saludo', a: 'peligro' },
    { de: 'peligro', a: 'emergencia', ramo: 'sí' },
    { de: 'peligro', a: 'reporte', ramo: 'no' },
    { de: 'emergencia', a: 'ubicacion' },
    { de: 'reporte', a: 'ubicacion' },
    { de: 'ubicacion', a: 'cobertura' },
    { de: 'cobertura', a: 'fuera', ramo: 'no' },
    { de: 'cobertura', a: 'detalle', ramo: 'sí' },
    { de: 'detalle', a: 'contacto' },
    { de: 'contacto', a: 'confirma' },
    { de: 'confirma', a: 'corregir', ramo: 'no' },
    { de: 'confirma', a: 'ticket', ramo: 'sí' },
    { de: 'ticket', a: 'escala' },
    { de: 'escala', a: 'despacho', ramo: 'sí' },
    { de: 'escala', a: 'cierre', ramo: 'no' },
  ];

  private static readonly ANCHO_NODO = 128;
  private static readonly ALTO_NODO = 40;
  private static readonly PASO_FILA = 74;
  private static readonly PASO_COL = 152;

  /** Centro de un nodo en el lienzo. */
  private static centro(nodo: { fila: number; col: number }): { x: number; y: number } {
    return {
      x: 190 + nodo.col * ContactDetailPage.PASO_COL,
      y: 32 + nodo.fila * ContactDetailPage.PASO_FILA,
    };
  }

  /**
   * El árbol con el estado de cada nodo y cada arista.
   *
   * `hecho` = el flujo pasó por ahí. `actual` = está parado ahí ahora.
   * `descartado` = es la rama que la decisión NO tomó, y se dibuja fantasma:
   * ver el camino que se descartó es lo que convierte una lista de pasos en
   * una decisión.
   */
  readonly arbol = computed(() => {
    const pasos = this.hitos().map((a) => a.paso.toLowerCase());
    const ultimo = pasos.at(-1) ?? '';
    const cerrada = this.mensajesDelCaso().length > 0;

    const tocado = (claves?: string[]) =>
      !!claves && pasos.some((p) => claves.some((c) => p.includes(c)));

    const hechos = new Set(
      ContactDetailPage.MAPA.filter((n) => tocado(n.claves)).map((n) => n.id),
    );
    // Una decisión se dio por recorrida si alguno de sus hijos lo fue.
    for (const d of ContactDetailPage.MAPA.filter((n) => n.decision)) {
      if (ContactDetailPage.MAPA.some((n) => n.padre === d.id && hechos.has(n.id))) hechos.add(d.id);
    }

    const idActual = cerrada
      ? null
      : (ContactDetailPage.MAPA.find((n) => n.claves?.some((c) => ultimo.includes(c)))?.id ?? null);

    const nodos = ContactDetailPage.MAPA.map((n) => {
      const { x, y } = ContactDetailPage.centro(n);
      // Descartado: hermano de una rama que sí se tomó.
      const hermanoVivo =
        !!n.padre &&
        !hechos.has(n.id) &&
        ContactDetailPage.MAPA.some((o) => o.padre === n.padre && o.id !== n.id && hechos.has(o.id));
      return {
        ...n,
        x,
        y,
        estado: hermanoVivo
          ? 'descartado'
          : n.id === idActual
            ? 'actual'
            : hechos.has(n.id)
              ? 'hecho'
              : 'pendiente',
      };
    });

    const porId = new Map(nodos.map((n) => [n.id, n]));
    const aristas = ContactDetailPage.ARISTAS.map((e) => {
      const a = porId.get(e.de)!;
      const b = porId.get(e.a)!;
      const y1 = a.y + ContactDetailPage.ALTO_NODO / 2;
      const y2 = b.y - ContactDetailPage.ALTO_NODO / 2;
      const medio = (y1 + y2) / 2;
      return {
        ...e,
        d: `M ${a.x} ${y1} C ${a.x} ${medio}, ${b.x} ${medio}, ${b.x} ${y2}`,
        // Viva solo si los DOS extremos se recorrieron: así la corriente
        // marca el camino real y no ilumina lo que todavía no pasó.
        viva: hechos.has(a.id) && hechos.has(b.id),
        muerta: b.estado === 'descartado',
        etiquetaX: (a.x + b.x) / 2,
        etiquetaY: medio - 2,
      };
    });

    const filas = Math.max(...ContactDetailPage.MAPA.map((n) => n.fila));
    return { nodos, aristas, alto: 32 + filas * ContactDetailPage.PASO_FILA + 40 };
  });

  /**
   * La silueta de un nodo, con la MISMA forma que el panal de Agentes: los
   * pasos son hexágonos alargados (la etiqueta no cabe en uno regular) y las
   * decisiones, rombos. Las dos redondeadas con el mismo criterio.
   */
  formaDe(n: { x: number; y: number; decision?: boolean }): string {
    const w = ContactDetailPage.ANCHO_NODO;
    const h = ContactDetailPage.ALTO_NODO;
    return n.decision ? romboRedondo(n.x, n.y, w, h + 12) : hexAlargado(n.x, n.y, w, h);
  }

  readonly pasosPendientes = computed(() => {
    if (this.mensajesDelCaso().length) return [];
    const hechos = this.hitos().map((a) => a.paso.toLowerCase());
    if (!hechos.length) return [];
    const cumplido = (claves: string[]) => hechos.some((h) => claves.some((c) => h.includes(c)));
    if (cumplido(['regist', 'farewell', 'closing'])) return [];
    return ContactDetailPage.RUTA.filter((p) => !cumplido(p.claves));
  });

  /**
   * Resumen del hilo y su caso en el CRM. Cambia mucho menos que el contexto
   * —consulta HubSpot— así que el sondeo lo recarga cada varias vueltas, no
   * en cada una.
   */
  readonly expediente = httpResource<Expediente>(() => `/api/contacts/${this.id()}/expediente`);

  /**
   * ¿El contacto realmente no existe (404), o fue un fallo del servidor?
   * Distinguirlo importa: decir "no se encontró" ante un 500 pasajero manda
   * al operador a buscar un problema que no existe.
   */
  /**
   * Fallos seguidos al cargar el hilo. El sondeo ya reintenta cada pocos
   * segundos, pero la pantalla de error saltaba al PRIMER fallo: un blip del
   * servidor —o el pool de Postgres ocupado un instante— tapaba una
   * conversación que un segundo después cargaba bien. La pantalla prometía
   * "se reintenta solo" y aun así se mostraba, que era lo contradictorio.
   *
   * Un 404 no entra acá: ese sí es definitivo y se muestra de una.
   */
  private readonly fallosSeguidos = signal(0);

  /** Solo se rinde tras varios intentos fallidos consecutivos. */
  readonly errorPersistente = computed(
    () => this.conversacionInexistente() || this.fallosSeguidos() >= 3,
  );

  readonly conversacionInexistente = computed(() => {
    const err = this.context.error();
    const causa = (err as { cause?: unknown })?.cause ?? err;
    return causa instanceof HttpErrorResponse && causa.status === 404;
  });

  /** Base de las rutas del sidebar, para no salirse del módulo. */
  readonly threadBase = computed(() => (this.withThreads() ? '/conversations' : '/contacts'));

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  readonly callState = signal<CallState>('idle');
  readonly callSeconds = signal(0);
  readonly sending = signal(false);
  readonly draft = signal('');
  /** Motivo del último envío rechazado por el proveedor (WhatsApp/SMS). */
  readonly sendError = signal<string | null>(null);
  readonly expanded = signal<Set<string>>(new Set());

  readonly channelLabel = channelLabel;
  readonly channelIconName = channelIconName;
  readonly channelColor = channelColor;

  /** Quién atiende el hilo; null en `operador` = lo atiende el agente. */
  readonly atencion = computed(() => this.expediente.value()?.atencion ?? null);
  readonly tomada = computed(() => !!this.atencion()?.operador);

  /**
   * Qué hace el compositor: anotar para el equipo o responderle al ciudadano.
   *
   * Arranca en `nota` a propósito. Responder solo tiene sentido con el hilo
   * TOMADO: si lo atiende el agente y el operador escribe, saldrían dos voces
   * contestando lo mismo. Al soltar el hilo vuelve solo a `nota`.
   */
  readonly modo = signal<'nota' | 'responder'>('nota');

  alternarModo(): void {
    if (!this.tomada()) return;
    this.modo.update((m) => (m === 'nota' ? 'responder' : 'nota'));
  }

  /**
   * El lugar del caso, para la burbuja de ubicación.
   *
   * El pin de WhatsApp tampoco nos llega, pero el flujo geocodifica la
   * referencia que dio el ciudadano y guarda dirección y coordenadas: eso sí
   * se puede mostrar y abrir en el mapa.
   */
  readonly lugarDelCaso = computed(() => {
    const capturado = this.expediente.value()?.resumen?.capturado ?? [];
    const de = (campo: string) => capturado.find((d) => d.campo === campo)?.valor?.trim();
    const texto = de('direccionFormateada') ?? de('Ubicación') ?? de('ubicacion');
    const lat = de('latitud');
    const lng = de('longitud');
    if (!texto && !(lat && lng)) return null;
    return {
      texto: texto ?? 'Ver en el mapa',
      mapa:
        lat && lng
          ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(texto!)}`,
    };
  });

  /**
   * Nombre del operador, nunca un identificador. El backend ya resuelve el
   * nombre real, pero si un hilo quedó tomado con un id viejo guardado, acá
   * se cae a "vos" en vez de escupir un UUID.
   */
  readonly quienAtiende = computed(() => {
    const op = this.atencion()?.operador?.trim();
    if (!op) return null;
    const esId = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(op) || /^[0-9a-f]{16,}$/i.test(op);
    return esId ? null : op;
  });
  readonly cambiandoAtencion = signal(false);

  /**
   * Las acciones solo se muestran con el hilo TOMADO: mientras lo atiende el
   * agente, esas mismas cosas las hace su flujo y mostrarlas invitaría al
   * operador a duplicar el trabajo.
   */
  readonly acciones = computed(() =>
    this.tomada() ? (this.expediente.value()?.acciones ?? []) : [],
  );

  /** Acción que se está ejecutando ahora, para bloquear solo esa pill. */
  readonly ejecutando = signal<string | null>(null);

  /**
   * Ejecuta la acción sugerida. Solo las accionables: "falta la ubicación" es
   * un aviso para que el operador lo pregunte, no algo que el sistema pueda
   * hacer por él.
   */
  async ejecutarAccion(accion: AccionSugerida): Promise<void> {
    if (accion.tipo !== 'ejecutable' || this.ejecutando()) return;
    this.ejecutando.set(accion.id);
    this.sendError.set(null);
    try {
      const r = await this.api.ejecutarAccion(this.id(), accion.id);
      if (r.aviso) this.sendError.set(r.aviso);
      this.expediente.reload();
    } catch (err: unknown) {
      const msg = (err as { error?: { message?: string } })?.error?.message;
      this.sendError.set(msg ?? 'No se pudo ejecutar la acción.');
    } finally {
      this.ejecutando.set(null);
    }
  }

  /** Tomar el hilo o devolvérselo al agente. */
  async alternarAtencion(): Promise<void> {
    if (this.cambiandoAtencion()) return;
    this.cambiandoAtencion.set(true);
    try {
      const tomando = !this.tomada();
      const r = await this.api.atenderConversacion(this.id(), tomando);
      // Al tomarla se le manda el saludo al ciudadano; si no salió, se dice.
      this.sendError.set(r.aviso ?? null);
      // Al soltar, el compositor vuelve a nota: el agente retoma el hilo.
      this.modo.set(tomando ? 'responder' : 'nota');
      this.expediente.reload();
    } finally {
      this.cambiandoAtencion.set(false);
    }
  }

  /**
   * El sidebar en el orden en que un operador espera verlo: el hilo con
   * movimiento más reciente arriba, sea porque llegó un mensaje nuevo o
   * porque alguien lo acaba de responder. `lastInteraction` no distingue
   * dirección a propósito — un envío nuestro también cuenta como actividad.
   */
  /**
   * Los hilos, del más reciente al más viejo — contando TAMBIÉN los avances
   * del flujo. Ordenar solo por el último mensaje mandaba al fondo la
   * conversación que estaba abriéndose en ese momento, que es justo la que
   * hay que mirar.
   */
  readonly hilos = computed(() => {
    const flujo = this.enCurso();
    return [...(this.conversations.value() ?? [])]
      .map((c) => {
        const estado = c.phones
          .map((p) => flujo.get(p.replace(/\D/g, '')))
          .filter((x): x is FlujoEnCurso => !!x)
          .sort((a, b) => a.lastFlowAt.localeCompare(b.lastFlowAt))
          .at(-1);
        const ultimoAvance = estado?.lastFlowAt ?? '';
        const mensaje = c.lastInteraction?.occurredAt ?? '';
        return {
          ...c,
          // El agente está conversando y todavía no hay hilo que mostrar.
          enCurso: !!ultimoAvance && ultimoAvance > mensaje,
          // Se quedó sin respuesta y nadie cerró el caso: alguien tiene que tomarla.
          inconclusa: !!estado?.inconclusa,
          cuando: ultimoAvance > mensaje ? ultimoAvance : mensaje,
        };
      })
      .sort((a, b) => b.cuando.localeCompare(a.cuando));
  });
  readonly sentimentClass = sentimentClass;
  readonly sentimentLabel = sentimentLabel;
  readonly kycmLabel = kycmLabel;

  constructor() {
    /*
     * Abrir un hilo siempre muestra el final; después, el refresco solo
     * arrastra si ya estabas abajo (si estás leyendo mensajes viejos, no se
     * te mueve la pantalla).
     *
     * Dos cosas rompían lo primero. Una, `primerRender` se gastaba con el
     * chat TODAVÍA VACÍO —el hilo carga después que el componente—, así que
     * el scroll real nunca ocurría. Y dos, Angular REUTILIZA este componente
     * al cambiar de conversación: sin reponer la bandera, el segundo hilo que
     * abrías se quedaba arriba. Por eso el efecto de `id()` la repone.
     */
    effect(() => {
      const mensajes = this.chat();
      const el = this.scrollEl()?.nativeElement;
      if (!el || !mensajes.length) return;

      const pegadoAlFondo = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (!pegadoAlFondo && !this.primerRender) return;

      const alFinal = this.primerRender;
      this.primerRender = false;
      // Dos cuadros: el primero deja que Angular pinte las burbujas nuevas,
      // el segundo mide ya con el alto definitivo. Con un solo setTimeout(0)
      // el hilo largo se quedaba a media altura.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: alFinal ? 'auto' : 'smooth' });
        }),
      );
    });

    // Lleva la cuenta de fallos seguidos: un error suelto no tapa el hilo,
    // varios seguidos sí significan que algo está mal de verdad.
    effect(() => {
      if (this.context.error()) this.fallosSeguidos.update((n) => n + 1);
      else if (this.context.value()) this.fallosSeguidos.set(0);
    });

    /*
     * Avisa por sonido cuando el caso se mueve, sin obligar a mirar la
     * pantalla. Se compara contra lo anterior y no contra "hubo cambios":
     * el sondeo re-emite el mismo arreglo en cada vuelta y sonaría siempre.
     *
     * El escalamiento tiene su propio tono y gana: es el único que justifica
     * interrumpir lo que el operador esté haciendo.
     */
    let nodosPrevios = -1;
    let escalado = false;
    effect(() => {
      const hitos = this.hitos();
      const ahoraEscalado = hitos.some((a) => a.paso === 'escalamiento');

      if (nodosPrevios >= 0 && ahoraEscalado && !escalado) this.sonido.tocar('escalado');
      else if (nodosPrevios >= 0 && hitos.length > nodosPrevios) this.sonido.tocar('avance');

      nodosPrevios = hitos.length;
      escalado = ahoraEscalado;
    });

    this.iniciarRefrescoAutomatico();
    /*
     * Cuando el ciudadano vuelve a escribir, NL Pearl abre una conversación
     * nueva sobre el mismo hilo. Eso es un caso nuevo: la elección manual de
     * tab del caso anterior ya no aplica, y el automático tiene que volver a
     * decidir — que sin mensajes todavía significa mostrar el Flujo en curso.
     */
    effect(() => {
      this.conversacionActual();
      this.vista.set(null);
    });

    // Al alternar de conversación se resetea el estado de llamada/composer,
    // y la elección Chat/Caso vuelve al automático del hilo nuevo.
    effect(() => {
      this.id();
      this.resetCallUi();
      this.vista.set(null);
      // Hilo nuevo: se abre mostrando el final, como al entrar la primera vez.
      this.primerRender = true;
    });
  }

  /** Hilo en orden cronológico (el API lo trae descendente) + separadores. */
  /**
   * Agente que atiende el hilo: el de la última interacción que trae
   * `handledBy`. Se muestra en la cabecera del chat porque con voz, SMS,
   * WhatsApp y varios Pearls conviviendo, quién contesta es parte del hilo.
   */
  readonly agente = computed(() => {
    const conAgente = [...(this.context.value()?.recentInteractions ?? [])]
      .filter((i) => i.handledBy)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    return conAgente ? { nombre: conAgente.handledBy!, channel: conAgente.channel } : null;
  });

  readonly chat = computed<ChatItem[]>(() => {
    const interactions = [...(this.context.value()?.recentInteractions ?? [])].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
    let lastDay = '';
    const items = interactions.map((interaction) => {
      const date = new Date(interaction.occurredAt);
      const day = date.toDateString();
      const item: ChatItem = {
        interaction,
        side: interaction.direction === 'inbound' ? 'in' : 'out',
        dayLabel: day !== lastDay ? this.dayLabel(date) : null,
        time: date.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' }),
        abreGrupo: true,
        cierraGrupo: true,
      };
      lastDay = day;
      return item;
    });

    /*
     * Agrupa los mensajes seguidos del mismo lado, como cualquier chat: el
     * avatar y la hora salen una vez por tanda, no en cada burbuja. Antes una
     * ráfaga de cuatro mensajes del ciudadano repetía cuatro veces su inicial
     * y cuatro veces la misma hora, y el hilo se leía como un formulario.
     *
     * Corta la tanda el cambio de lado, el cambio de día y un hueco de más de
     * cinco minutos: pasado ese rato, ya no es la misma intervención.
     */
    const MISMA_TANDA_MS = 5 * 60_000;
    for (let i = 0; i < items.length; i++) {
      const previo = items[i - 1];
      if (!previo) continue;
      const salto = new Date(items[i].interaction.occurredAt).getTime() -
        new Date(previo.interaction.occurredAt).getTime();
      const sigue =
        previo.side === items[i].side && !items[i].dayLabel && salto <= MISMA_TANDA_MS;
      if (!sigue) continue;
      items[i].abreGrupo = false;
      previo.cierraGrupo = false;
    }
    return items;
  });

  /** Nombres técnicos de los nodos → algo legible en la línea de tiempo. */
  private static readonly PASOS: Record<string, string> = {
    opening: 'Abrió la conversación',
    closing: 'Cerró la conversación',
    emergency: 'Detectó una emergencia',
    identifyNeed: 'Identificó la necesidad',
    escalamiento: 'Escalado al despacho',
    geocodeLocation: 'Ubicación verificada',
    collectDetails: 'Detalles adicionales',
    offerPhoto: 'Solicitud de evidencia',
    safetyCheck: 'Verificación de seguridad',
    collectProblem: 'Recopiló el tipo de problema',
    collectLocation: 'Recopiló la ubicación',
    collectDesc: 'Recopiló la descripción',
    collectContact: 'Recopiló los datos de contacto',
    confirmInfo: 'Confirmó la información',
    registered: 'Registró el reporte',
    consultaTramite: 'Orientó sobre el trámite',
  };

  etiquetaPaso(paso: string): string {
    return ContactDetailPage.PASOS[paso] ?? paso;
  }

  /**
   * Un vistazo, no el texto completo. La descripción del ciudadano puede
   * ocupar un párrafo entero; en la línea de tiempo se corta y el resto queda
   * en el `title`. El texto íntegro vive en la conversación y en la ficha.
   */
  recorte(valor: string, tope = 80): string {
    const limpio = valor.replace(/\s+/g, ' ').trim();
    if (limpio.length <= tope) return limpio;
    // Se corta en el último espacio para no partir una palabra por la mitad.
    const corte = limpio.slice(0, tope);
    return `${corte.slice(0, corte.lastIndexOf(' ') || tope)}…`;
  }

  /**
   * Número de ticket, solo si es un número. HubSpot los numera, así que sirve
   * para buscarlo allá; si algún día llegara un hash, no se muestra — en la
   * consola no se enseñan identificadores opacos.
   */
  readonly numeroDeTicket = computed(() => {
    const id = this.caso()?.id?.trim();
    return id && /^\d{1,12}$/.test(id) ? `#${id}` : null;
  });

  /** "24 ago" — para fechas de apertura/movimiento del caso. */
  fechaCorta(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('es-NI', { day: 'numeric', month: 'short' });
  }

  horaCorta(iso?: string): string {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
  }

  readonly initials = computed(() => this.initialsOf(this.context.value()?.contact.displayName));

  readonly timerLabel = computed(() => {
    const s = this.callSeconds();
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  });

  // ===== Contexto en vivo (panel derecho) =====

  /** Último sentimiento conocido del hilo. */
  readonly mood = computed<{ label: string; cls: string; pct: number } | null>(() => {
    const last = (this.context.value()?.recentInteractions ?? []).find((i) => i.sentiment);
    if (!last?.sentiment) return null;
    const map: Record<Sentiment, { label: string; cls: string; pct: number }> = {
      positive: { label: 'Positivo', cls: 'mood--positive', pct: 86 },
      neutral: { label: 'Neutral', cls: 'mood--neutral', pct: 55 },
      negative: { label: 'Negativo', cls: 'mood--negative', pct: 24 },
    };
    return map[last.sentiment];
  });

  /**
   * Resumen del agente. Antes era "el último mensaje", que no resume nada:
   * ahora sale del expediente — el resumen que redacta el propio agente
   * (`post_call_summary`) o, si no hay, uno compuesto con lo que el flujo
   * recopiló. La ficha de datos capturados acompaña al texto.
   */
  readonly resumenAgente = computed(() => this.expediente.value()?.resumen ?? null);

  /** Caso real del CRM: etapa viva, no un rótulo fijo. */
  readonly caso = computed(() => this.expediente.value()?.caso ?? null);

  /**
   * Refresco periódico: los mensajes entrantes llegan por webhook, así que sin
   * esto no aparecen hasta recargar a mano.
   *
   * Ritmo adaptativo (ver `crearSondeo`): arranca en 2 s y se estira hasta 20 s
   * mientras el hilo no cambie. El fijo de 1,2 s anterior era plata tirada —
   * con varias pestañas abiertas llegaba a ~8 req/s contra la API.
   */
  private iniciarRefrescoAutomatico(): void {
    let vuelta = 0;
    // Espejo NL Pearl: al abrir el hilo y luego cada ~10 vueltas (el backend
    // además tiene su propio rate-limit, así que varias pestañas no duplican).
    void this.api.syncNlpearl().catch(() => undefined);

    const detener = crearSondeo({
      base: 2_000,
      max: 20_000,
      activo: () => !this.sending(),
      // Cantidad de mensajes + el más reciente: si eso no cambió, el hilo
      // está igual y no hace falta seguir preguntando al mismo ritmo.
      // Cambia si llega un mensaje NUEVO o un avance del flujo: cualquiera de
      // los dos significa que el hilo está vivo y vuelve al ritmo rápido.
      firma: () => {
        const inter = this.context.value()?.recentInteractions;
        if (!inter) return undefined;
        const av = this.progreso.value() ?? [];
        return `${inter.length}:${inter[0]?.occurredAt ?? ''}:${av.length}:${av[av.length - 1]?.occurredAt ?? ''}`;
      },
      alSondear: () => {
        this.context.reload();
        // La línea de tiempo va al mismo ritmo que el hilo: su URL ya no
        // cambia sola, así que sin esto se quedaría congelada.
        this.progreso.reload();
        // La lista de hilos cambia menos: se refresca cada 3 vueltas.
        if (++vuelta % 3 === 0 && this.withThreads()) this.conversations.reload();
        // El expediente consulta el CRM: se refresca aún más espaciado.
        if (vuelta % 6 === 0) this.expediente.reload();
        if (vuelta % 10 === 0) void this.api.syncNlpearl().catch(() => undefined);
      },
    });

    this.destroyRef.onDestroy(detener);
  }

  activePromise(): BrainSignal | undefined {
    return this.context.value()?.signals.find((s) => s.type === 'promise' && s.status === 'active');
  }

  /** Número de caso estable derivado del contactId (solo presentación). */
  caseNumber(): string {
    const id = this.id();
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `CAS-${String(hash % 100000).padStart(5, '0')}`;
  }

  // ===== Sidebar de conversaciones =====

  initialsOf(name?: string): string {
    return (name || 'Anónimo')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  tileColor(id: string): string {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return TILE_COLORS[hash % TILE_COLORS.length];
  }

  preview(c: ContactListItem): string {
    return this.truncate(c.lastInteraction?.summary ?? 'Sin mensajes todavía', 46);
  }

  shortTime(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString('es-NI', { day: '2-digit', month: 'short' });
  }

  truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  dayLabel(date: Date): string {
    const today = new Date();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    if (date.toDateString() === today.toDateString()) return 'Hoy';
    if (date.toDateString() === yesterday.toDateString()) return 'Ayer';
    return date.toLocaleDateString('es-NI', { day: '2-digit', month: 'long' });
  }

  toggleTranscript(id: string): void {
    const next = new Set(this.expanded());
    next.has(id) ? next.delete(id) : next.add(id);
    this.expanded.set(next);
  }

  // ===== Llamada =====

  /** Inicia la llamada mock y observa el Brain hasta que entre la interacción de voz. */
  async startCall(): Promise<void> {
    if (this.callState() === 'calling') return;
    this.callState.set('calling');
    this.callSeconds.set(0);
    this.callStartedAt = Date.now();

    this.timerInterval = setInterval(() => this.callSeconds.update((s) => s + 1), 1000);

    try {
      await this.api.triggerCall(this.id());
    } catch {
      this.endCall();
      return;
    }

    this.pollInterval = setInterval(async () => {
      this.context.reload();
      // Solo cuenta la interacción de voz creada por ESTA llamada (2s de tolerancia de reloj).
      const hasNewVoice = (this.context.value()?.recentInteractions ?? []).some(
        (i) => i.channel === 'voice' && new Date(i.occurredAt).getTime() >= this.callStartedAt - 2_000,
      );
      if (hasNewVoice || Date.now() - this.callStartedAt > 25_000) this.endCall();
    }, 1200);
  }

  endCall(): void {
    clearInterval(this.timerInterval);
    clearInterval(this.pollInterval);
    if (this.callState() === 'calling') this.callState.set('ended');
    this.context.reload();
    this.conversations.reload();
  }

  private resetCallUi(): void {
    clearInterval(this.timerInterval);
    clearInterval(this.pollInterval);
    this.callState.set('idle');
    this.callSeconds.set(0);
    this.draft.set('');
    this.expanded.set(new Set());
  }

  async sendFollowup(): Promise<void> {
    this.sending.set(true);
    this.sendError.set(null);
    try {
      await this.api.sendFollowup(this.id(), 'whatsapp');
      this.context.reload();
      this.conversations.reload();
    } catch (err) {
      this.sendError.set(this.describeSendError(err));
    } finally {
      this.sending.set(false);
    }
  }

  /**
   * El proveedor puede rechazar el envío (sesión de 24 h vencida, credenciales,
   * número no habilitado). Sin esto el mensaje simplemente no aparecía y no
   * quedaba claro por qué.
   */
  private describeSendError(err: unknown): string {
    const message = (err as { error?: { message?: string } })?.error?.message;
    return message ?? 'No se pudo guardar la nota. Intentá de nuevo.';
  }

  onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Composer = NOTA INTERNA: los agentes (Pearls) conversan con el cliente;
   * lo que escribe el operador acá queda en el hilo solo para el equipo.
   */
  async addNote(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      if (this.modo() === 'responder') await this.api.enviarMensaje(this.id(), text);
      else await this.api.addNote(this.id(), text);
      this.draft.set('');
      this.context.reload();
    } catch (err) {
      // El texto se conserva en el composer para poder reintentar.
      this.sendError.set(this.describeSendError(err));
    } finally {
      this.sending.set(false);
    }
  }

  ngOnDestroy(): void {
    clearInterval(this.timerInterval);
    clearInterval(this.pollInterval);
  }
}
