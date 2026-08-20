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
import { httpResource } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { BrainApiService } from '../../brain-api.service';
import { Icon } from '../../icon';
import { VoiceNebula } from '../../nebula';
import { ContactListItem, Interaction, Sentiment, Signal as BrainSignal, UnifiedContext } from '../../models';
import { channelIcon, channelLabel, kycmLabel, sentimentClass, sentimentLabel } from '../../ui';

/** Mensaje del hilo, listo para pintar como burbuja. */
interface ChatItem {
  interaction: Interaction;
  side: 'in' | 'out';
  dayLabel: string | null; // separador de día (solo en el primer msg del día)
  time: string;
}

/** Momento clave para el panel de contexto. */
interface KeyMoment {
  when: string;
  title: string;
  detail: string;
  channel: Interaction['channel'];
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

  readonly channelIcon = channelIcon;
  readonly channelLabel = channelLabel;
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

    this.iniciarRefrescoAutomatico();
    // Al alternar de conversación se resetea el estado de llamada/composer.
    effect(() => {
      this.id();
      this.resetCallUi();
    });
  }

  /** Hilo en orden cronológico (el API lo trae descendente) + separadores. */
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

  /** Resumen "de IA": el resumen de la última llamada de voz (o del hilo). */
  readonly aiSummary = computed<string | null>(() => {
    const interactions = this.context.value()?.recentInteractions ?? [];
    return interactions.find((i) => i.channel === 'voice')?.summary ?? interactions[0]?.summary ?? null;
  });

  /** Momentos clave: últimas interacciones condensadas. */
  readonly keyMoments = computed<KeyMoment[]>(() =>
    (this.context.value()?.recentInteractions ?? []).slice(0, 3).map((i) => ({
      when: `${this.dayLabel(new Date(i.occurredAt))} ${new Date(i.occurredAt).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' })}`,
      title:
        i.channel === 'voice'
          ? `Llamada de voz ${i.direction === 'inbound' ? 'entrante' : 'saliente'}`
          : i.direction === 'inbound'
            ? `Mensaje del cliente (${channelLabel(i.channel)})`
            : `Seguimiento por ${channelLabel(i.channel)}`,
      detail: this.truncate(i.summary ?? '', 64),
      channel: i.channel,
    })),
  );

  /**
   * Refresco periódico: los mensajes entrantes llegan por webhook, así que sin
   * esto no aparecen hasta recargar a mano. Cada 1,2 s para que se sienta
   * inmediato; se pausa con la pestaña oculta para no gastar invocaciones.
   */
  private iniciarRefrescoAutomatico(): void {
    let vuelta = 0;
    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible' || this.sending()) return;
      this.context.reload();
      // La lista de hilos cambia menos: se refresca cada 3 vueltas.
      if (++vuelta % 3 === 0 && this.withThreads()) this.conversations.reload();
    }, 1200);

    // Al volver a la pestaña, refresco inmediato en vez de esperar el tick.
    const alVolver = () => {
      if (document.visibilityState === 'visible') this.context.reload();
    };
    document.addEventListener('visibilitychange', alVolver);

    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', alVolver);
    });
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
    return (name ?? '?')
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
    return message ?? 'No se pudo enviar el mensaje. Revisá el estado en Integraciones.';
  }

  onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  async sendMessage(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      await this.api.sendMessage(this.id(), text, 'whatsapp');
      this.draft.set('');
      this.context.reload();
      this.conversations.reload();
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
