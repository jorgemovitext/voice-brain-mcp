import { Component, DestroyRef, computed, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Icon } from '../../icon';
import { HiveStatus, WebhookEvent } from '../../models';
import { crearSondeo } from '../../sondeo';
import { channelIconName, channelLabel } from '../../ui';

/**
 * Actividad: qué está pasando ahora mismo en los canales. Cifras del día,
 * reparto por canal, ritmo por hora, la cola de espera, el último movimiento
 * y los eventos crudos de los webhooks.
 *
 * La configuración de proveedores (URLs, credenciales, prueba de conexión)
 * salió de acá: es configuración, no actividad.
 */
@Component({
  selector: 'app-integrations',
  imports: [RouterLink, Icon],
  templateUrl: './integrations.html',
  styleUrl: './integrations.scss',
})
export class IntegrationsPage {
  private readonly destroyRef = inject(DestroyRef);

  readonly hive = httpResource<HiveStatus>(() => '/api/hive');
  readonly activity = httpResource<WebhookEvent[]>(() => '/api/integrations/activity');

  readonly channelIconName = channelIconName;
  readonly channelLabel = channelLabel;

  readonly m = computed(() => this.hive.value()?.metricas);

  /** Canales con tráfico, ordenados, con el ancho de barra ya resuelto. */
  readonly canales = computed(() => {
    const porCanal = (this.hive.value()?.porCanal ?? []).filter((c) => c.total > 0);
    const tope = Math.max(1, ...porCanal.map((c) => c.total));
    return porCanal
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ ...c, pct: Math.round((c.total / tope) * 100) }));
  });

  readonly picoHora = computed(() => Math.max(0, ...(this.m()?.porHora ?? [])));

  readonly horas = computed(() => {
    const serie = this.m()?.porHora ?? [];
    const tope = Math.max(1, ...serie);
    return serie.map((total, hora) => ({
      hora,
      total,
      pct: Math.round((total / tope) * 100),
      pico: total > 0 && total === tope,
    }));
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
        const h = this.hive.value();
        return `${h?.actividad?.[0]?.occurredAt ?? ''}|${h?.metricas?.esperandoRespuesta ?? ''}`;
      },
    });
    this.destroyRef.onDestroy(parar);
  }

  refrescar(): void {
    this.hive.reload();
    this.activity.reload();
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
