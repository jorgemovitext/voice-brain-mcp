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
import {
  AvanceFlujo,
  AccionSugerida,
  Expediente,
  ContactListItem,
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

/** Mensaje del hilo, listo para pintar como burbuja. */
interface ChatItem {
  interaction: Interaction;
  side: 'in' | 'out';
  dayLabel: string | null; // separador de día (solo en el primer msg del día)
  time: string;
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
  readonly hitos = computed(() => {
    const orden = [...(this.progreso.value() ?? [])].sort((a, b) =>
      (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''),
    );
    const ultima = [...orden].reverse().find((a) => a.conversationId)?.conversationId;
    const delCaso = ultima ? orden.filter((a) => a.conversationId === ultima || !a.conversationId) : orden;
    return ContactDetailPage.conDeltas(delCaso);
  });

  /**
   * Qué mostrar en el cuerpo del panel: el diagrama del caso o el chat.
   *
   * `null` = automático: mientras Pearl solo manda avances (la conversación
   * llega entera al cerrar o escalar), lo único vivo es el CASO y eso es lo
   * que se muestra; en cuanto hay mensajes, el chat pasa al frente solo. El
   * tab de la cabecera fija la elección manual, y cambiar de hilo la borra.
   */
  readonly vista = signal<'chat' | 'flujo' | null>(null);
  readonly vistaActiva = computed(() => this.vista() ?? (this.chat().length ? 'chat' : 'flujo'));

  /** Estado del caso para la cabecera del diagrama. */
  readonly estadoCaso = computed<{ clase: string; texto: string }>(() => {
    if (this.chat().length) return { clase: 'fin', texto: 'Conversación completa' };
    if (this.hitos().some((a) => a.paso === 'escalamiento'))
      return { clase: 'escala', texto: 'Escalado al despacho' };
    if (this.hitos().length) return { clase: 'vivo', texto: 'Caso formándose en vivo' };
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

  readonly pasosPendientes = computed(() => {
    if (this.chat().length) return [];
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
  readonly hilos = computed(() =>
    [...(this.conversations.value() ?? [])].sort((a, b) =>
      (b.lastInteraction?.occurredAt ?? '').localeCompare(a.lastInteraction?.occurredAt ?? ''),
    ),
  );
  readonly sentimentClass = sentimentClass;
  readonly sentimentLabel = sentimentLabel;
  readonly kycmLabel = kycmLabel;

  constructor() {
    // Auto-scroll al último mensaje, pero solo si ya estabas al final: si
    // estás leyendo mensajes viejos, el refresco automático no te mueve.
    effect(() => {
      this.chat();
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      const pegadoAlFondo = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (pegadoAlFondo || this.primerRender) {
        this.primerRender = false;
        setTimeout(() => (el.scrollTop = el.scrollHeight), 0);
      }
    });

    // Lleva la cuenta de fallos seguidos: un error suelto no tapa el hilo,
    // varios seguidos sí significan que algo está mal de verdad.
    effect(() => {
      if (this.context.error()) this.fallosSeguidos.update((n) => n + 1);
      else if (this.context.value()) this.fallosSeguidos.set(0);
    });

    this.iniciarRefrescoAutomatico();
    // Al alternar de conversación se resetea el estado de llamada/composer,
    // y la elección Chat/Caso vuelve al automático del hilo nuevo.
    effect(() => {
      this.id();
      this.resetCallUi();
      this.vista.set(null);
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
    return interactions.map((interaction) => {
      const date = new Date(interaction.occurredAt);
      const day = date.toDateString();
      const item: ChatItem = {
        interaction,
        side: interaction.direction === 'inbound' ? 'in' : 'out',
        dayLabel: day !== lastDay ? this.dayLabel(date) : null,
        time: date.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' }),
      };
      lastDay = day;
      return item;
    });
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
