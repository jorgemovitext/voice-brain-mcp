import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { BrainApiService } from '../../brain-api.service';
import { Channel, HiveStatus, Integracion, WebhookEvent } from '../../models';
import { crearSondeo } from '../../sondeo';
import { channelColor, channelLabel } from '../../ui';

/**
 * Actividad: qué está pasando ahora mismo en los canales.
 *
 * Mismo lenguaje visual que el tablero de inicio (tokens `--d-*`, chips,
 * riel derecho), pero con MENOS gráfico: acá el protagonista es el registro
 * de eventos, que ocupa la banda central y se filtra de verdad. El contexto
 * cuantitativo se comprime en el riel.
 *
 * La configuración de proveedores (URLs de webhook, API keys, prueba de
 * conexión) salió de esta vista: es configuración, no actividad.
 */

/** Un color por origen, para leer el registro sin leer la etiqueta. */
const COLOR_FUENTE: Record<string, string> = {
  nlpearl: '#2196CC',
  gupshup: '#729B26',
  'whatsapp-cloud': '#729B26',
  precall: '#B08968',
  saliente: '#D9532C',
};

const OK = '#34D399';
const MAL = '#F87171';
const NEUTRO = 'rgba(255,255,255,0.10)';

@Component({
  selector: 'app-integrations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './integrations.html',
  styleUrl: './integrations.scss',
})
export class IntegrationsPage {
  private readonly destroyRef = inject(DestroyRef);

  private readonly api = inject(BrainApiService);
  private readonly auth = inject(AuthService);

  readonly hive = httpResource<HiveStatus>(() => '/api/hive');
  readonly activity = httpResource<WebhookEvent[]>(() => '/api/integrations/activity');
  /*
   * La configuración de proveedores salió de esta vista a propósito, pero el
   * ESTADO sí es actividad: si una credencial falta, lo que se ve en el
   * registro es un silencio que no se explica solo. Va compacto y sin
   * secretos — el gateway nunca los devuelve.
   */
  readonly conexiones = httpResource<Integracion[]>(() => '/api/integrations');

  /** Prueba de la plantilla de saludo: manda un WhatsApp real. */
  readonly numeroPrueba = signal('');
  readonly probando = signal(false);
  readonly resultadoPrueba = signal<string | null>(null);

  async probarPlantilla(): Promise<void> {
    const to = this.numeroPrueba().trim();
    if (!to || this.probando()) return;
    this.probando.set(true);
    this.resultadoPrueba.set(null);
    try {
      // {{1}} es el nombre de quien atiende: el mismo que saldría de verdad.
      const quien = this.auth.user()?.name?.trim() || 'un operador de la AMDC';
      const r = await this.api.probarPlantilla(to, quien);
      this.resultadoPrueba.set(r.ok ? 'Plantilla aceptada por Gupshup.' : (r.error ?? 'Rechazada.'));
    } catch (e) {
      this.resultadoPrueba.set((e as Error).message);
    } finally {
      this.probando.set(false);
      this.activity.reload();
    }
  }

  escribirNumero(event: Event): void {
    this.numeroPrueba.set((event.target as HTMLInputElement).value);
  }

  /**
   * Solo los detalles que cambian de estado: URLs y nombres fijos no aportan
   * nada acá y alargarían el riel sin decir nada nuevo.
   */
  detalles(c: Integracion): Array<{ k: string; v: string }> {
    return Object.entries(c.details ?? {})
      .filter(([k, v]) => k === 'Estado' || /configurad|falta|sin |validad/i.test(String(v)))
      .map(([k, v]) => ({ k, v: String(v) }));
  }

  /** null = todos los orígenes. */
  readonly fuente = signal<string | null>(null);
  readonly soloFallos = signal(false);

  readonly channelLabel = channelLabel;
  readonly OK = OK;
  readonly MAL = MAL;
  readonly NEUTRO = NEUTRO;

  readonly m = computed(() => this.hive.value()?.metricas);

  /** Orígenes presentes: solo se ofrecen filtros que devuelven algo. */
  readonly fuentes = computed(() => [...new Set((this.activity.value() ?? []).map((e) => e.source))]);

  readonly eventos = computed(() =>
    (this.activity.value() ?? [])
      .filter((e) => !this.fuente() || e.source === this.fuente())
      .filter((e) => !this.soloFallos() || !e.ok),
  );

  /**
   * Canales con tráfico. Las mini-píldoras del riel son 6 casillas: cuántas
   * se encienden es la proporción de ese canal contra el más cargado.
   */
  readonly canales = computed(() => {
    const porCanal = (this.hive.value()?.porCanal ?? []).filter((c) => c.total > 0);
    const tope = Math.max(1, ...porCanal.map((c) => c.total));
    return porCanal
      .sort((a, b) => b.total - a.total)
      .map((c) => {
        const encendidas = Math.max(1, Math.round((c.total / tope) * 6));
        return { ...c, pills: Array.from({ length: 6 }, (_, i) => i < encendidas) };
      });
  });

  readonly totalCanal = computed(() => this.canales().reduce((acc, c) => acc + c.total, 0));
  readonly entrantes = computed(() => this.canales().reduce((acc, c) => acc + c.inbound, 0));

  /** Explica el guion cuando no hay dato, en vez de dejarlo sin contexto. */
  readonly enVivoTitulo = computed(() => {
    const v = this.hive.value()?.enVivo;
    if (!v) return 'Sin dato en vivo: no hay agente de WhatsApp asignado, o no respondió';
    return v.enCola ? `${v.total} en curso, ${v.enCola} en cola` : `${v.total} en curso`;
  });

  constructor() {
    // Es una pantalla de "ahora mismo": se refresca sola y se calla si no pasa nada.
    const parar = crearSondeo({
      base: 8000,
      max: 60000,
      alSondear: () => {
        this.hive.reload();
        this.activity.reload();
      },
      firma: () => {
        const e = this.activity.value()?.[0];
        const v = this.hive.value()?.enVivo;
        return `${e?.at ?? ''}|${this.m()?.esperandoRespuesta ?? ''}|${v?.total ?? ''}`;
      },
    });
    this.destroyRef.onDestroy(parar);
  }

  refrescar(): void {
    this.hive.reload();
    this.activity.reload();
  }

  alternarFuente(f: string): void {
    this.fuente.update((actual) => (actual === f ? null : f));
  }

  limpiarFiltros(): void {
    this.fuente.set(null);
    this.soloFallos.set(false);
  }

  colorFuente(f: string): string {
    return COLOR_FUENTE[f] ?? '#8A8F98';
  }

  colorCanal(c: Channel): string {
    return channelColor(c);
  }

  /** Espera en lenguaje humano: los minutos crudos no dicen nada de un vistazo. */
  espera(min: number): string {
    if (min < 1) return 'recién';
    if (min < 60) return `${Math.round(min)} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
  }
}
