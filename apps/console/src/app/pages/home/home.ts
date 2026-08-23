import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { BrainApiService } from '../../brain-api.service';
import { Icon } from '../../icon';
import { HiveStatus } from '../../models';
import { VoiceNebula } from '../../nebula';
import { channelIconName, channelLabel } from '../../ui';

/** Una burbuja del panel "en vivo": quien espera primero, luego lo último. */
interface FeedBubble {
  contactId: string;
  side: 'in' | 'out';
  title: string;
  text: string;
  when: string;
  /** true = está en la cola: se pinta con acento y botón de responder. */
  waiting?: boolean;
}

/**
 * La colmena — primera pantalla, estilo "coach" claro: saludo grande con el
 * estado real, barra de progreso de hilos atendidos, accesos circulares,
 * panel derecho en vivo (quien espera y qué acaba de pasar, clickeable al
 * hilo) y el resumen del día abajo. Se refresca sola y dispara el sync.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon, VoiceNebula],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private readonly router = inject(Router);
  private readonly api = inject(BrainApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly auth = inject(AuthService);

  readonly hive = httpResource<HiveStatus>(() => '/api/hive');
  readonly query = signal('');
  readonly vista = signal<'hoy' | 'total'>('hoy');
  readonly syncing = signal(false);

  readonly channelIconName = channelIconName;
  readonly channelLabel = channelLabel;

  /** Primer nombre del operador, para el saludo. */
  readonly nombre = computed(() => this.auth.user()?.name?.split(/\s+/)[0] ?? '');

  /** Titular según el estado del panal: es un mensaje, no una decoración. */
  readonly titular = computed(() => {
    const h = this.hive.value();
    if (!h) return '¡Hola!';
    const n = h.metricas.esperandoRespuesta;
    if (n > 0) return n === 1 ? 'Alguien espera respuesta.' : `${n} personas esperan respuesta.`;
    return h.obreros.activos ? 'Tu enjambre está listo.' : 'La colmena está en reposo.';
  });

  /** Obreros activos: se pintan como avatares vivos, no como un número. */
  readonly enjambre = computed(() => this.hive.value()?.obreros.enElPanal ?? []);

  /** Progreso de atención: hilos al día sobre hilos con actividad. */
  readonly atencion = computed(() => {
    const h = this.hive.value();
    const alDia = h?.metricas.hilosAlDia ?? 0;
    const total = alDia + (h?.metricas.esperandoRespuesta ?? 0);
    return { alDia, total, pct: total ? Math.round((alDia / total) * 100) : 100 };
  });

  /** Burbujas del panel en vivo: la cola primero, después la actividad. */
  readonly feed = computed<FeedBubble[]>(() => {
    const h = this.hive.value();
    if (!h) return [];
    const esperas: FeedBubble[] = h.esperando.slice(0, 3).map((t) => ({
      contactId: t.contactId,
      side: 'in',
      title: t.displayName || t.phone || 'Sin nombre',
      text: t.summary || '(sin resumen)',
      when: this.espera(t.waitingMin),
      waiting: true,
    }));
    const enCola = new Set(esperas.map((e) => e.contactId));
    const resto: FeedBubble[] = h.actividad
      .filter((a) => !(enCola.has(a.contactId) && a.direction === 'inbound'))
      .slice(0, 4)
      .map((a) => ({
        contactId: a.contactId,
        side: a.direction === 'inbound' ? ('in' as const) : ('out' as const),
        title:
          a.direction === 'inbound'
            ? a.displayName || 'Contacto'
            : a.channel === 'note'
              ? `Nota para ${a.displayName || 'el hilo'}`
              : `Obrero → ${a.displayName || 'contacto'}`,
        text: a.summary || '…',
        when: this.hora(a.occurredAt),
      }));
    return [...esperas, ...resto].slice(0, 5);
  });

  /** Reparto por canal con su arco (share del tráfico total). */
  readonly canales = computed(() => {
    const h = this.hive.value();
    if (!h?.porCanal.length) return [];
    const total = h.porCanal.reduce((a, c) => a + c.total, 0) || 1;
    return h.porCanal.map((c) => ({
      ...c,
      pct: Math.round((c.total / total) * 100),
      dash: `${Math.max(6, Math.round((c.total / total) * 63))} 63`,
    }));
  });

  /** Barras del resumen: por hora (hoy) o por canal (total). */
  readonly barras = computed<Array<{ v: number; label?: string }>>(() => {
    const h = this.hive.value();
    if (!h) return [];
    if (this.vista() === 'hoy') {
      const max = Math.max(1, ...h.metricas.porHora);
      return h.metricas.porHora.map((v) => ({ v: v / max }));
    }
    const max = Math.max(1, ...h.porCanal.map((c) => c.total));
    return h.porCanal.map((c) => ({ v: c.total / max, label: channelLabel(c.channel) }));
  });

  readonly totalVista = computed(() => {
    const h = this.hive.value();
    if (!h) return 0;
    return this.vista() === 'hoy'
      ? h.metricas.conversacionesHoy
      : h.porCanal.reduce((a, c) => a + c.total, 0);
  });

  /** Anillos de la cola (estilo actividad): naranja = al día, negro = esperando. */
  readonly anillos = computed(() => {
    const { alDia, total } = this.atencion();
    const esperando = total - alDia;
    const C1 = 2 * Math.PI * 52;
    const C2 = 2 * Math.PI * 38;
    return {
      alDia: `${(total ? alDia / total : 1) * C1} ${C1}`,
      esperando: `${(total ? esperando / total : 0) * C2} ${C2}`,
    };
  });

  constructor() {
    void this.api.syncNlpearl().catch(() => undefined);
    let vuelta = 0;
    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.hive.reload();
      if (++vuelta % 6 === 0) void this.api.syncNlpearl().catch(() => undefined);
    }, 5000);
    this.destroyRef.onDestroy(() => clearInterval(tick));
  }

  /** Botón "Sincronizar": trae ya mismo lo nuevo de NL Pearl. */
  async syncNow(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    try {
      await this.api.syncNlpearl(false);
      // De paso repara hilos ingeridos con un mapeo viejo. Es idempotente y
      // no depende de la API de NL Pearl (que no permite releer los chats),
      // así que si falla no arruina el sync.
      await this.api.reprocessChats().catch(() => undefined);
      this.hive.reload();
    } catch {
      /* el refresco periódico reintenta */
    } finally {
      this.syncing.set(false);
    }
  }

  search(): void {
    const q = this.query().trim();
    this.router.navigate(['/contacts'], q ? { queryParams: { q } } : undefined);
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  espera(min: number): string {
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
  }

  hora(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
  }
}
