import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Analytics, Channel } from '../../models';
import { crearSondeo } from '../../sondeo';
import { channelColor, channelLabel } from '../../ui';

/**
 * Tablero de inicio, calcado del layout de la referencia (AppDynamics):
 * cabecera con título, barra de filtros, menú interno a la izquierda, MAPA DE
 * FLUJO al centro con las tarjetas de resultado a su derecha, fila inferior
 * (carga · actividad por hora · medidor de sin-respuesta) y riel derecho con
 * eventos, barras de salud segmentadas, marcador y la cola en espera.
 *
 * El tema NO es el de la referencia: usa la paleta navy del resto de la app
 * (--panel/--panel-2/--border). Los colores de dato sí están verificados
 * sobre superficie oscura (#729B26/#2196CC/#D9532C para canales, ΔE 22.2 en
 * el peor par bajo daltonismo); verde/ámbar/rojo quedan reservados a estado
 * y siempre van acompañados de etiqueta y número.
 */

const OK = '#34D399';
const MAL = '#F87171';
const ALERTA = '#FFB020';
const NEUTRO = 'rgba(255,255,255,0.10)';

/**
 * El nodo que el backend usa cuando una conversación no dejó ningún avance.
 * Sus cintas salen de vidrio, no de color: ver `CintaSankey.cristal`.
 */
const SIN_CLASIFICAR = 'Sin clasificar';

interface NodoSankey {
  id: string;
  col: number;
  etiqueta: string;
  /** Texto del tooltip: el nodo solo muestra su cifra, no su peso relativo. */
  tip: string;
  total: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  /** Tag de resultado (solo columna final). */
  tag?: { texto: string; color: string };
}

interface CintaSankey {
  d: string;
  grosor: number;
  color: string;
  /** Extremos verticales: con ellos se detecta si cruza a otra cinta. */
  y1: number;
  y2: number;
  /** Tramo: 0 = canal→problema, 1 = problema→resultado. Solo cruzan dentro del mismo. */
  seg: number;
  /** Pasa por ENCIMA de otra en un cruce: se le aplica el vidrio. */
  encima: boolean;
  /**
   * Sale de "Sin clasificar": se pinta como vidrio esmerilado en vez de con
   * el color del resultado. Ese nodo no es una categoría, es la ausencia de
   * una; darle el verde de "atendida" o el rojo de "en espera" afirmaría algo
   * que no sabemos.
   */
  cristal: boolean;
  /** Texto del tooltip: la cinta sola no dice de dónde viene ni cuánto pesa. */
  tip: string;
}

/** Píldora flotante de contexto, anclada al cursor. */
interface Tip {
  x: number;
  y: number;
  texto: string;
  color?: string;
}

@Component({
  selector: 'app-tablero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './tablero.html',
  styleUrl: './tablero.scss',
})
export class TableroPage {
  readonly dias = signal(14);
  /** null = todos los canales. Filtra el tablero completo, no solo un gráfico. */
  readonly canal = signal<Channel | null>(null);
  readonly datos = httpResource<Analytics>(() => {
    const c = this.canal();
    return `/api/analytics?dias=${this.dias()}${c ? `&canal=${c}` : ''}`;
  });

  /** Canales con tráfico, para ofrecer solo filtros que devuelven algo. */
  readonly canalesDisponibles = computed(() =>
    (this.a()?.porCanal ?? []).map((c) => c.channel).filter((c) => c !== 'note'),
  );

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    /*
     * El tablero se cargaba UNA vez y se quedaba ahí: con la consola abierta
     * en una pared, los números eran los de cuando alguien la abrió.
     *
     * Va más lento que el resto (10 s a 60 s) a propósito: /api/analytics
     * recorre todas las interacciones del rango y además consulta HubSpot, así
     * que no es una consulta para pedir cada dos segundos. La firma corta al
     * ritmo lento cuando nada cambia.
     */
    const detener = crearSondeo({
      base: 10_000,
      max: 60_000,
      firma: () => {
        const r = this.datos.value()?.resumen;
        return r ? `${r.conversaciones}:${r.mensajes}:${r.sinRespuesta}` : undefined;
      },
      alSondear: () => this.datos.reload(),
    });
    this.destroyRef.onDestroy(detener);
  }

  readonly a = computed(() => this.datos.value());
  readonly channelLabel = channelLabel;
  readonly OK = OK;
  readonly MAL = MAL;
  /** Punto del tooltip de las cintas de vidrio: no tienen color propio. */
  readonly VIDRIO = 'rgba(255,255,255,0.55)';
  /** Los mismos acentos que pintan cada gráfico, para el punto del tooltip. */
  readonly NARANJA = '#F34700';
  readonly CIAN = '#00BAFE';

  colorCanal(channel: Channel): string {
    return channelColor(channel);
  }

  cambiarRango(dias: number): void {
    this.dias.set(dias);
  }

  /** Alterna el filtro: volver a pulsar el canal activo lo quita. */
  alternarCanal(canal: Channel): void {
    this.canal.update((actual) => (actual === canal ? null : canal));
  }

  // ===== Tooltip =====

  /**
   * Una sola píldora para todo el tablero, anclada al cursor con
   * `position: fixed`. Se sigue con `mousemove` porque en SVG los puntos son
   * diminutos y un tooltip quieto queda lejos del dato que explica.
   */
  readonly tip = signal<Tip | null>(null);

  verTip(ev: MouseEvent, texto: string, color?: string): void {
    this.tip.set({ x: ev.clientX, y: ev.clientY, texto, color });
  }

  moverTip(ev: MouseEvent): void {
    this.tip.update((t) => (t ? { ...t, x: ev.clientX, y: ev.clientY } : t));
  }

  sinTip(): void {
    this.tip.set(null);
  }

  /** "3 de 11 (27%)" — el crudo sin la proporción no dice si es mucho. */
  private static parte(n: number, total: number): string {
    if (!total) return `${n}`;
    return `${n} de ${total} (${Math.round((n / total) * 100)}%)`;
  }

  tipSalud(): string {
    const r = this.a()?.resumen;
    if (!r) return '';
    return `Sin respuesta ${TableroPage.parte(r.sinRespuesta, r.conversaciones)} · atendidas ${r.atendidos}`;
  }

  tipCasos(): string {
    const c = this.a()?.casos;
    if (!c?.configurado) return '';
    const total = (c.enCurso ?? 0) + (c.cerrados ?? 0);
    return `Resueltos ${TableroPage.parte(c.cerrados ?? 0, total)} · ${c.enCurso ?? 0} en curso`;
  }

  tipGauge(): string {
    const r = this.a()?.resumen;
    if (!r) return '';
    return `${this.gauge().pct}% sin respuesta — ${TableroPage.parte(r.sinRespuesta, r.conversaciones)} conversaciones`;
  }

  // ===== Mapa de flujo (sankey de 3 columnas) =====

  /**
   * Geometría del sankey en un viewBox 720×300. Tres columnas: canal →
   * problema → resultado. El alto de cada nodo y el grosor de cada cinta son
   * proporcionales a sus conversaciones; las cintas se apilan en el borde del
   * nodo en orden estable para que no se crucen más de lo necesario.
   */
  readonly sankey = computed(() => {
    const flujo = this.a()?.flujo ?? [];
    if (!flujo.length) return null;

    const S = flujo.reduce((acc, f) => acc + f.total, 0);

    // Problemas: top 4 y el resto plegado en "Otros" (regla de series).
    const porProblema = new Map<string, number>();
    for (const f of flujo) porProblema.set(f.problema, (porProblema.get(f.problema) ?? 0) + f.total);
    const top = [...porProblema.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
    const nombreProblema = (p: string) => (top.includes(p) ? p : 'Otros');

    const totales = (ids: string[], de: (f: Analytics['flujo'][number]) => string) => {
      const m = new Map(ids.map((id) => [id, 0]));
      for (const f of flujo) {
        const id = de(f);
        m.set(id, (m.get(id) ?? 0) + f.total);
      }
      return m;
    };

    const canales = [...new Set(flujo.map((f) => f.canal))];
    const problemas = [...new Set(flujo.map((f) => nombreProblema(f.problema)))];
    const resultados = ['atendida', 'esperando'].filter((r) => flujo.some((f) => f.resultado === r));

    const columnas: Array<{ ids: string[]; x: number; w: number; tot: Map<string, number> }> = [
      { ids: canales, x: 6, w: 132, tot: totales(canales, (f) => f.canal) },
      { ids: problemas, x: 288, w: 158, tot: totales(problemas, (f) => nombreProblema(f.problema)) },
      { ids: resultados, x: 578, w: 136, tot: totales(resultados, (f) => f.resultado) },
    ];

    const nodos = new Map<string, NodoSankey>();
    for (const [col, c] of columnas.entries()) {
      const gaps = 14 * (c.ids.length - 1);
      const usable = 288 - gaps;
      let y = 6;
      for (const id of c.ids) {
        const total = c.tot.get(id) ?? 0;
        const h = Math.max(34, (total / S) * usable);
        const etiqueta =
          col === 0 ? channelLabel(id as never)
          : col === 2 ? (id === 'atendida' ? 'Atendida' : 'En espera')
          : id;
        nodos.set(`${col}:${id}`, {
          id,
          col,
          etiqueta,
          tip: `${etiqueta}: ${TableroPage.parte(total, S)} conversaciones`,
          total,
          x: c.x,
          y,
          w: c.w,
          h,
          color: col === 0 ? this.colorCanal(id as never) : col === 2 ? (id === 'atendida' ? OK : MAL) : undefined,
          tag: col === 2 ? { texto: id === 'atendida' ? 'OK' : 'Espera', color: id === 'atendida' ? OK : MAL } : undefined,
        });
        y += h + 14;
      }
    }

    // Cintas con apilado por nodo: cada arista consume su franja del borde.
    const usadoSalida = new Map<string, number>();
    const usadoEntrada = new Map<string, number>();
    const cinta = (a: NodoSankey, b: NodoSankey, total: number, color: string, seg: number): CintaSankey => {
      const grosor = Math.max(4, (total / S) * 150);
      const y1 = a.y + (usadoSalida.get(`${a.col}:${a.id}`) ?? 0) + grosor / 2 + 4;
      const y2 = b.y + (usadoEntrada.get(`${b.col}:${b.id}`) ?? 0) + grosor / 2 + 4;
      usadoSalida.set(`${a.col}:${a.id}`, (usadoSalida.get(`${a.col}:${a.id}`) ?? 0) + grosor + 2);
      usadoEntrada.set(`${b.col}:${b.id}`, (usadoEntrada.get(`${b.col}:${b.id}`) ?? 0) + grosor + 2);
      const x1 = a.x + a.w;
      const x2 = b.x;
      const mx = (x1 + x2) / 2;
      return {
        d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        grosor,
        color,
        y1,
        y2,
        seg,
        encima: false,
        cristal: a.id === SIN_CLASIFICAR,
        tip: `${a.etiqueta} → ${b.etiqueta}: ${TableroPage.parte(total, S)}`,
      };
    };

    // Agregación por par: una cinta por par de nodos, no por combinación.
    const par = (
      m: Map<string, { a: string; b: string; total: number; color: string }>,
      a: string,
      b: string,
      total: number,
      color: string,
    ) => {
      const k = `${a}→${b}`;
      const e = m.get(k) ?? { a, b, total: 0, color };
      e.total += total;
      m.set(k, e);
    };
    const izq = new Map<string, { a: string; b: string; total: number; color: string }>();
    const der = new Map<string, { a: string; b: string; total: number; color: string }>();
    for (const f of flujo) {
      const p = nombreProblema(f.problema);
      par(izq, f.canal, p, f.total, this.colorCanal(f.canal));
      par(der, p, f.resultado, f.total, f.resultado === 'atendida' ? OK : MAL);
    }

    const cintas: CintaSankey[] = [];
    for (const e of izq.values()) cintas.push(cinta(nodos.get(`0:${e.a}`)!, nodos.get(`1:${e.b}`)!, e.total, e.color, 0));
    for (const e of der.values()) cintas.push(cinta(nodos.get(`1:${e.a}`)!, nodos.get(`2:${e.b}`)!, e.total, e.color, 1));

    /*
     * Orden de pintado = orden de apilamiento. Se pintan de la más delgada a
     * la más gruesa, así el flujo principal queda arriba; y una cinta se marca
     * `encima` si CRUZA a alguna ya pintada. Cruzar es invertir el orden
     * vertical entre salida y llegada: (y1a−y1b) y (y2a−y2b) con signo opuesto.
     * Solo esas reciben el vidrio — las de abajo se quedan planas, como en la
     * referencia.
     */
    cintas.sort((a, b) => a.grosor - b.grosor);
    for (const [i, c] of cintas.entries()) {
      c.encima = cintas
        .slice(0, i)
        .some((prev) => prev.seg === c.seg && (prev.y1 - c.y1) * (prev.y2 - c.y2) < 0);
    }

    return { nodos: [...nodos.values()], cintas };
  });

  // ===== Fila inferior =====

  /** Lollipops por día (viewBox 100×46, base y=40). */
  readonly curva = computed(() => {
    const dias = this.a()?.porDia ?? [];
    if (dias.length < 2) return null;
    const max = Math.max(1, ...dias.map((d) => d.conversaciones));
    const paso = 100 / (dias.length - 1);
    const puntos = dias.map((d, i) => ({
      x: +(i * paso).toFixed(2),
      y: +(40 - (d.conversaciones / max) * 36).toFixed(2),
      dia: d.dia,
      valor: d.conversaciones,
      tip: `${this.diaCorto(d.dia)}: ${d.conversaciones} conversación(es) · ${d.mensajes} mensajes`,
    }));
    // Los puntos miden 1,2 de radio: sin una banda invisible alrededor no hay
    // forma humana de acertarles con el cursor.
    return { max, paso, puntos, ultimo: puntos[puntos.length - 1] };
  });

  /** Mensajes por día promedio, el "calls/min" de la referencia. */
  readonly porDiaProm = computed(() => {
    const a = this.a();
    if (!a) return 0;
    return +(a.resumen.mensajes / Math.max(1, a.rango.dias)).toFixed(1);
  });

  /** Dispersión por hora: solo horas con tráfico (puntos, no columnas). */
  readonly horasDots = computed(() => {
    const porHora = this.a()?.porHora ?? [];
    const max = Math.max(1, ...porHora);
    return porHora
      .map((total, hora) => ({
        hora,
        total,
        x: +(2 + (hora / 23) * 96).toFixed(2),
        y: +(40 - (total / max) * 32).toFixed(2),
        tip: `${String(hora).padStart(2, '0')}:00 — ${total} mensaje(s)${total === max ? ' · hora pico' : ''}`,
      }))
      .filter((p) => p.total > 0);
  });

  readonly horaPico = computed(() => {
    const porHora = this.a()?.porHora ?? [];
    const max = Math.max(...porHora, 0);
    return max ? { hora: porHora.indexOf(max), total: max } : null;
  });

  /** Medidor: proporción sin respuesta. 28 marcas verde→ámbar→rojo + aguja. */
  readonly gauge = computed(() => {
    const r = this.a()?.resumen;
    const pct = r && r.conversaciones ? r.sinRespuesta / r.conversaciones : 0;
    const marcas = Array.from({ length: 28 }, (_, i) => {
      const t = i / 27;
      const ang = Math.PI - t * Math.PI; // 180° → 0°
      const color = t < 0.55 ? OK : t < 0.8 ? ALERTA : MAL;
      return {
        x1: +(50 + Math.cos(ang) * 34).toFixed(2),
        y1: +(52 - Math.sin(ang) * 34).toFixed(2),
        x2: +(50 + Math.cos(ang) * 44).toFixed(2),
        y2: +(52 - Math.sin(ang) * 44).toFixed(2),
        color,
      };
    });
    const angA = Math.PI - Math.min(1, pct) * Math.PI;
    return {
      pct: Math.round(pct * 100),
      marcas,
      aguja: {
        x: +(50 + Math.cos(angA) * 28).toFixed(2),
        y: +(52 - Math.sin(angA) * 28).toFixed(2),
      },
    };
  });

  // ===== Riel derecho =====

  /** 12 píldoras coloreadas por partes; cualquier parte > 0 enciende ≥ 1. */
  pildoras(partes: Array<{ n: number; color: string }>): string[] {
    const total = partes.reduce((acc, p) => acc + p.n, 0);
    if (!total) return Array(12).fill(NEUTRO);
    const out: string[] = [];
    for (const p of partes) {
      if (!p.n) continue;
      const cant = Math.max(1, Math.round((p.n / total) * 12));
      for (let i = 0; i < cant && out.length < 12; i++) out.push(p.color);
    }
    while (out.length < 12) out.push(out[out.length - 1] ?? NEUTRO);
    return out;
  }

  readonly saludConversaciones = computed(() => {
    const r = this.a()?.resumen;
    if (!r) return null;
    return {
      pills: this.pildoras([
        { n: r.sinRespuesta, color: MAL },
        { n: r.atendidos, color: OK },
      ]),
      texto: `${r.sinRespuesta} sin respuesta / ${r.atendidos} atendidas`,
    };
  });

  readonly saludCasos = computed(() => {
    const c = this.a()?.casos;
    if (!c?.configurado) return null;
    return {
      pills: this.pildoras([
        { n: c.enCurso ?? 0, color: ALERTA },
        { n: c.cerrados ?? 0, color: OK },
      ]),
      texto: `${c.enCurso ?? 0} en curso / ${c.cerrados ?? 0} resueltos`,
    };
  });

  /** Marcador tipo "scorecard": una fila por problema, con mini-píldoras. */
  readonly marcador = computed(() => {
    const lista = this.a()?.problemas ?? [];
    const max = Math.max(1, ...lista.map((x) => x.total));
    const suma = lista.reduce((acc, x) => acc + x.total, 0);
    return lista.slice(0, 5).map((x) => ({
      ...x,
      tip: `${x.etiqueta}: ${TableroPage.parte(x.total, suma)} de los reportes`,
      pills: this.pildoras([
        { n: x.total, color: '#729B26' },
        { n: Math.max(0, max - x.total), color: NEUTRO },
      ]).slice(0, 6),
    }));
  });

  // ===== Formato =====

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
    return new Date(`${iso}T12:00:00`).toLocaleDateString('es-NI', { day: 'numeric', month: 'short' });
  }
}
