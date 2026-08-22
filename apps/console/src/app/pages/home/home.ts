import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Icon } from '../../icon';
import { VoiceNebula } from '../../nebula';
import { HiveStatus } from '../../models';
import { channelIconName, channelLabel } from '../../ui';

/**
 * La colmena: primera pantalla y centro de mando del enjambre.
 *
 * No es una portada — es donde se OPERA: la cola de "esperando respuesta"
 * lleva directo al hilo, el enjambre muestra qué obreros están en el panal,
 * y la actividad reciente cuenta qué acaba de pasar en todos los canales.
 * Se refresca sola y dispara el sync espejo, así el panal está vivo.
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

  readonly hive = httpResource<HiveStatus>(() => '/api/hive');
  readonly query = signal('');

  readonly channelIconName = channelIconName;
  readonly channelLabel = channelLabel;

  /** Pulso general del panal: ¿hay obreros trabajando? */
  readonly pulso = computed(() => {
    const h = this.hive.value();
    if (!h) return { label: 'Conectando…', ok: false };
    if (!h.obreros.activos) return { label: 'Colmena en reposo — sin obreros activos', ok: false };
    return { label: `${h.obreros.activos} obrero(s) en el panal`, ok: true };
  });

  constructor() {
    // El panal vivo: sync espejo al entrar y refresco periódico visible.
    void this.api.syncNlpearl().catch(() => undefined);
    let vuelta = 0;
    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.hive.reload();
      if (++vuelta % 6 === 0) void this.api.syncNlpearl().catch(() => undefined);
    }, 5000);
    this.destroyRef.onDestroy(() => clearInterval(tick));
  }

  search(): void {
    const q = this.query().trim();
    this.router.navigate(['/contacts'], q ? { queryParams: { q } } : undefined);
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** "hace 5 min" / "hace 2 h" — el tiempo de espera es el dato clave de la cola. */
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
