import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Analytics } from '../../models';
import { channelLabel } from '../../ui';

/**
 * Tablero analítico: lo que se atiende, cómo y con qué resultado.
 *
 * Va debajo de la primera pantalla de La colmena — esa se mantiene sin scroll
 * y sirve para OPERAR; esto es para ENTENDER, y aparece al bajar.
 *
 * Sobre los colores: son los de la marca pero verificados, no elegidos a ojo.
 * El cian #00BAFE no llega a 3:1 sobre fondo claro, así que en gráficos se usa
 * el paso #0090C4, que sí pasa contraste manteniendo el tono. Los tres colores
 * de canal pasan además separación para daltonismo (ΔE 11.2 en el peor par).
 * Cada barra lleva su valor escrito: el color nunca es el único portador.
 */

/** Paleta categórica verificada. El canal fija el color, nunca su posición. */
const COLOR_CANAL: Record<string, string> = {
  whatsapp: '#F34700',
  voice: '#0090C4',
  sms: '#7C5CFF',
  email: '#8A6D3B',
  note: '#92939b',
};

@Component({
  selector: 'app-tablero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './tablero.html',
  styleUrl: './tablero.scss',
})
export class TableroPage {
  /** Ventana de análisis. El usuario la cambia con los botones de arriba. */
  readonly dias = signal(14);
  readonly datos = httpResource<Analytics>(() => `/api/analytics?dias=${this.dias()}`);

  readonly a = computed(() => this.datos.value());
  readonly channelLabel = channelLabel;

  colorCanal(channel: string): string {
    return COLOR_CANAL[channel] ?? '#92939b';
  }

  cambiarRango(dias: number): void {
    this.dias.set(dias);
  }

  // ===== Serie por día =====

  /** Puntos de la curva en coordenadas del viewBox (0..100 x, 0..40 y). */
  readonly curva = computed(() => {
    const dias = this.a()?.porDia ?? [];
    if (dias.length < 2) return null;
    const max = Math.max(1, ...dias.map((d) => d.conversaciones));
    const paso = 100 / (dias.length - 1);
    const puntos = dias.map((d, i) => ({
      x: +(i * paso).toFixed(2),
      y: +(38 - (d.conversaciones / max) * 34).toFixed(2),
      dia: d.dia,
      valor: d.conversaciones,
    }));
    return {
      max,
      puntos,
      linea: puntos.map((p) => `${p.x},${p.y}`).join(' '),
      area: `0,40 ${puntos.map((p) => `${p.x},${p.y}`).join(' ')} 100,40`,
      ultimo: puntos[puntos.length - 1],
    };
  });

  /** Solo unas pocas fechas en el eje: etiquetar los 14 días es ilegible. */
  readonly ejeDias = computed(() => {
    const dias = this.a()?.porDia ?? [];
    if (!dias.length) return [];
    const idx = [0, Math.floor(dias.length / 2), dias.length - 1];
    return [...new Set(idx)].map((i) => ({
      pct: (i / Math.max(1, dias.length - 1)) * 100,
      etiqueta: this.diaCorto(dias[i].dia),
    }));
  });

  // ===== Por hora =====

  readonly horas = computed(() => {
    const porHora = this.a()?.porHora ?? [];
    const max = Math.max(1, ...porHora);
    return porHora.map((total, hora) => ({ hora, total, pct: (total / max) * 100 }));
  });

  readonly horaPico = computed(() => {
    const h = this.horas();
    if (!h.length) return null;
    const pico = h.reduce((a, b) => (b.total > a.total ? b : a));
    return pico.total ? pico : null;
  });

  // ===== Rankings =====

  readonly canales = computed(() => {
    const lista = this.a()?.porCanal ?? [];
    const max = Math.max(1, ...lista.map((c) => c.total));
    return lista.map((c) => ({ ...c, pct: (c.total / max) * 100 }));
  });

  readonly agentes = computed(() => {
    const lista = this.a()?.agentes ?? [];
    const max = Math.max(1, ...lista.map((x) => x.mensajes));
    return lista.slice(0, 6).map((x) => ({ ...x, pct: (x.mensajes / max) * 100 }));
  });

  readonly problemas = computed(() => {
    const lista = this.a()?.problemas ?? [];
    const max = Math.max(1, ...lista.map((x) => x.total));
    return lista.map((x) => ({ ...x, pct: (x.total / max) * 100 }));
  });

  readonly etapas = computed(() => {
    const lista = this.a()?.casos?.porEtapa ?? [];
    const max = Math.max(1, ...lista.map((x) => x.total));
    return lista.map((x) => ({ ...x, pct: (x.total / max) * 100 }));
  });

  // ===== Sentimiento (escala ordenada → barra divergente) =====

  readonly sentimiento = computed(() => {
    const s = this.a()?.sentimiento;
    if (!s) return null;
    const con = s.positive + s.neutral + s.negative;
    if (!con) return null;
    return {
      con,
      partes: [
        { clave: 'Negativo', valor: s.negative, color: '#C62828', pct: (s.negative / con) * 100 },
        { clave: 'Neutral', valor: s.neutral, color: '#8A8F98', pct: (s.neutral / con) * 100 },
        { clave: 'Positivo', valor: s.positive, color: '#2E7D32', pct: (s.positive / con) * 100 },
      ].filter((p) => p.valor > 0),
      sinDato: s.sinDato,
    };
  });

  // ===== Formato =====

  /** Minutos → algo que se lee de un vistazo ("2 h 15 min"). */
  duracion(min: number | null | undefined): string {
    if (min === null || min === undefined) return '—';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const resto = min % 60;
    if (h < 24) return resto ? `${h} h ${resto} min` : `${h} h`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  horas1(h: number | null | undefined): string {
    if (h === null || h === undefined) return '—';
    return h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
  }

  diaCorto(iso: string): string {
    const d = new Date(`${iso}T12:00:00`);
    return d.toLocaleDateString('es-NI', { day: 'numeric', month: 'short' });
  }
}
