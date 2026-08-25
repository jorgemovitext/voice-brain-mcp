import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Channel, HiveStatus, WebhookEvent } from '../../models';
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

  readonly hive = httpResource<HiveStatus>(() => '/api/hive');
  readonly activity = httpResource<WebhookEvent[]>(() => '/api/integrations/activity');

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
    if (!v) return 'Sin dato en vivo: no hay Pearl de WhatsApp asignada, o la API no respondió';
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
