import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Worker, WorkerFlow, WorkersResponse } from '../../models';

/** Una celda del panal ya resuelta a coordenadas de pantalla. */
interface Celda {
  w: Worker;
  /** Centro del hexágono, en unidades del viewBox. */
  x: number;
  y: number;
  /** Circunradio: la mitad del ancho del hexágono. */
  r: number;
  activo: boolean;
  /** Brillo del borde, 0..1. Cae con la distancia al centro, como en un panal. */
  luz: number;
  iniciales: string;
  /** Nombre partido en 1–2 líneas que caben dentro del hexágono. */
  lineas: string[];
}

/** Celda vacía del mosaico: pura decoración, completa el patrón del panal. */
interface CeldaVacia {
  x: number;
  y: number;
  r: number;
  luz: number;
}

/**
 * Espiral de coordenadas axiales de un panal: (0,0), luego el anillo 1, el 2…
 * Es el orden en que se van ocupando las celdas desde el centro hacia afuera.
 */
function espiral(anillos: number): Array<{ q: number; r: number }> {
  const out = [{ q: 0, r: 0 }];
  // Direcciones axiales de un hexágono, en orden para recorrer cada anillo.
  const DIR = [
    [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
  ];
  for (let k = 1; k <= anillos; k++) {
    let q = -k;
    let r = k;
    for (const [dq, dr] of DIR) {
      for (let paso = 0; paso < k; paso++) {
        out.push({ q, r });
        q += dq;
        r += dr;
      }
    }
  }
  return out;
}

/** Axial → píxel para hexágonos de lado plano arriba (vértices a izq/der). */
function aPixel(q: number, r: number, size: number): { x: number; y: number } {
  return { x: size * 1.5 * q, y: size * Math.sqrt(3) * (r + q / 2) };
}

/** Dos letras para el hexágono chico, donde no cabe el nombre. */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter((p) => /[a-záéíóúñ]/i.test(p[0] ?? ''));
  const dos = partes.slice(0, 2).map((p) => p[0]).join('');
  return (dos || nombre.slice(0, 2)).toUpperCase();
}

/**
 * Parte el nombre en hasta dos líneas de ~15 caracteres, que es lo que cabe
 * en la panza del hexágono grande sin tocar los bordes. Lo que no cabe se
 * corta con elipsis: el nombre completo va en el <title> de la celda.
 */
function lineasDe(nombre: string): string[] {
  const limpio = nombre.trim();
  if (limpio.length <= 15) return [limpio];
  const palabras = limpio.split(/\s+/);
  const l1: string[] = [];
  while (palabras.length && `${l1.join(' ')} ${palabras[0]}`.trim().length <= 15) {
    l1.push(palabras.shift()!);
  }
  if (!l1.length) l1.push(palabras.shift()!); // una sola palabra kilométrica
  let l2 = palabras.join(' ');
  if (l2.length > 16) l2 = `${l2.slice(0, 15).trimEnd()}…`;
  return l2 ? [l1.join(' '), l2] : [l1.join(' ')];
}

/**
 * Obreros: los Pearls de la cuenta NL Pearl como fuerza de trabajo, con su
 * workflow (flow del Pearl vía API cuando está disponible). Todo son
 * lecturas: no gasta llamadas ni créditos.
 */
@Component({
  selector: 'app-workers',
  imports: [RouterLink],
  templateUrl: './workers.html',
  styleUrl: './workers.scss',
})
export class WorkersPage {
  private readonly api = inject(BrainApiService);

  readonly data = httpResource<WorkersResponse>(() => '/api/workers');
  /** Id de la Pearl cuya asignación se está guardando. */
  readonly assigning = signal<string | null>(null);

  /**
   * El enjambre se parte en dos: los despiertos van en grande al centro del
   * panal (son los que están atendiendo) y los dormidos alrededor, chicos y
   * apagados, para no robarles protagonismo.
   */
  readonly vivos = computed(() =>
    (this.data.value()?.workers ?? []).filter((w) => (w.status ?? '').toLowerCase() === 'active'),
  );
  readonly dormidos = computed(() =>
    (this.data.value()?.workers ?? []).filter((w) => (w.status ?? '').toLowerCase() !== 'active'),
  );

  /**
   * El panal: los despiertos en grande al centro y los dormidos en hexágonos
   * chicos alrededor, los dos sobre retículas hexagonales concéntricas.
   *
   * Se usan DOS retículas —una de paso grande para los activos y otra de paso
   * chico para el resto— porque tamaños distintos no caben en una sola sin
   * solaparse. Los chicos empiezan donde termina el racimo central, así que el
   * mosaico se lee como un solo panal aunque por dentro sean dos.
   */
  private readonly mosaico = computed<{ celdas: Celda[]; deco: CeldaVacia[] }>(() => {
    const activos = this.vivos();
    const resto = this.dormidos();
    if (!activos.length && !resto.length) return { celdas: [], deco: [] };

    const R_GRANDE = 96;
    const R_CHICO = 40;
    const celdas: Celda[] = [];

    const posiciones = espiral(3);
    for (const [i, w] of activos.entries()) {
      const { q, r } = posiciones[i] ?? { q: 0, r: 0 };
      const { x, y } = aPixel(q, r, R_GRANDE);
      celdas.push({
        w, x, y, r: R_GRANDE, activo: true, luz: 1,
        iniciales: iniciales(w.name), lineas: lineasDe(w.name),
      });
    }

    // Dónde termina el racimo central: los chicos no pueden invadirlo.
    const radioNucleo = celdas.reduce((max, c) => Math.max(max, Math.hypot(c.x, c.y)), 0) + R_GRANDE;

    const libres = espiral(12)
      .map(({ q, r }) => aPixel(q, r, R_CHICO))
      .filter((p) => Math.hypot(p.x, p.y) > radioNucleo + R_CHICO * 0.9)
      .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));

    const ultimo = libres[Math.min(resto.length, libres.length) - 1];
    const alcance = Math.max(ultimo ? Math.hypot(ultimo.x, ultimo.y) : 0, radioNucleo + R_CHICO * 3);

    for (const [i, w] of resto.entries()) {
      const p = libres[i];
      if (!p) break;
      // Como en la referencia: la luz nace en el centro y se apaga hacia afuera.
      const d = Math.hypot(p.x, p.y);
      celdas.push({
        w, x: p.x, y: p.y, r: R_CHICO, activo: false,
        luz: Math.max(0.12, 1 - d / (alcance * 1.15)),
        iniciales: iniciales(w.name), lineas: [],
      });
    }

    /*
     * Celdas vacías: rellenan el hueco entre el racimo central y los
     * dormidos, y un anillo más allá del último, para que el conjunto se lea
     * como una pared de panal (la referencia) y no como piezas flotando.
     */
    const deco: CeldaVacia[] = libres
      .slice(resto.length)
      .filter((p) => Math.hypot(p.x, p.y) <= alcance + R_CHICO * 2.2)
      .map((p) => {
        const d = Math.hypot(p.x, p.y);
        return { ...p, r: R_CHICO, luz: Math.max(0.05, (1 - d / (alcance * 1.3)) * 0.45) };
      });

    return { celdas, deco };
  });

  readonly panal = computed(() => this.mosaico().celdas);
  readonly deco = computed(() => this.mosaico().deco);

  /** viewBox que encuadra el panal completo, con aire para el resplandor. */
  readonly vista = computed(() => {
    const todas = [...this.panal(), ...this.deco()];
    if (!todas.length) return { box: '0 0 100 100' };
    const m = todas.reduce(
      (a, x) => ({
        x0: Math.min(a.x0, x.x - x.r),
        x1: Math.max(a.x1, x.x + x.r),
        y0: Math.min(a.y0, x.y - x.r),
        y1: Math.max(a.y1, x.y + x.r),
      }),
      { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
    );
    const aire = 26;
    return {
      box: `${m.x0 - aire} ${m.y0 - aire} ${m.x1 - m.x0 + aire * 2} ${m.y1 - m.y0 + aire * 2}`,
    };
  });

  /** Los seis vértices de un hexágono de lado plano, centrado en (x,y). */
  puntos(c: { x: number; y: number; r: number }): string {
    return Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 180) * (60 * i);
      return `${(c.x + c.r * Math.cos(a)).toFixed(1)},${(c.y + c.r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
  }

  readonly selectedId = signal<string | null>(null);
  readonly flow = httpResource<WorkerFlow>(() =>
    this.selectedId() ? `/api/workers/${this.selectedId()}/flow` : undefined,
  );

  readonly selected = computed<Worker | null>(
    () => (this.data.value()?.workers ?? []).find((w) => w.id === this.selectedId()) ?? null,
  );

  /** Pares clave/valor del detalle, sin repetir lo ya visible en la tarjeta. */
  readonly selectedDetails = computed<Array<{ key: string; value: string }>>(() => {
    const raw = this.selected()?.raw ?? {};
    return Object.entries(raw)
      .filter(([key]) => !['id', 'name'].includes(key))
      .slice(0, 12)
      .map(([key, value]) => ({ key, value: String(value) }));
  });

  select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  statusClass(w: Worker): string {
    const s = (w.status ?? '').toLowerCase();
    if (['active', 'running', 'run', '1', 'true'].includes(s)) return 'pill--positive';
    if (['paused', 'pause', 'stopped', '0', 'false'].includes(s)) return 'pill--neutral';
    return 'pill--secondary';
  }

  statusLabel(w: Worker): string {
    const s = (w.status ?? '').toLowerCase();
    if (['active', 'running', 'run', '1', 'true'].includes(s)) return 'Activo';
    if (['paused', 'pause', 'stopped', '0', 'false'].includes(s)) return 'En pausa';
    return w.status ?? 'Estado desconocido';
  }

  /** ¿Esta Pearl es la asignada a su propio canal? */
  isAssigned(w: Worker): boolean {
    const routing = this.data.value()?.routing;
    return !!w.channel && routing?.[w.channel as 'voice' | 'whatsapp' | 'sms'] === w.id;
  }

  /**
   * Asigna o libera esta Pearl para su canal. Es el reemplazo del
   * NLPEARL_PEARL_ID del entorno: alternar es un clic, sin redeploy.
   */
  async toggleAssign(w: Worker, ev: Event): Promise<void> {
    ev.stopPropagation(); // no abrir/cerrar el detalle al asignar
    if (!w.channel) return;
    this.assigning.set(w.id);
    try {
      const canal = w.channel as 'voice' | 'whatsapp' | 'sms';
      await this.api.setPearlRouting(canal, this.isAssigned(w) ? null : w.id);
      this.data.reload();
    } finally {
      this.assigning.set(null);
    }
  }

  /** Canal legible: NL Pearl lo expone como agentType, acá se muestra en claro. */
  channelName(w: Worker): string {
    switch (w.channel) {
      case 'whatsapp':
        return 'WhatsApp';
      case 'sms':
        return 'SMS / texto';
      case 'voice':
        return 'Voz';
      default:
        return w.type ?? '';
    }
  }

  shortDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-NI', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  flowJson(flow: WorkerFlow['flow']): string {
    return JSON.stringify(flow, null, 2);
  }
}
