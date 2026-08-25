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
  /** Contorno ya resuelto: hexágono de esquinas redondeadas. */
  d: string;
}

/** Coordenada axial de una celda del panal. */
interface Axial {
  q: number;
  r: number;
}

/**
 * Espiral de coordenadas axiales de un panal: (0,0), luego el anillo 1, el 2…
 * Es el orden en que se van ocupando las celdas desde el centro hacia afuera.
 */
function espiral(anillos: number): Axial[] {
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

/**
 * ¿Se pisan dos hexágonos de esta orientación?
 *
 * Con la misma orientación, el test de ejes separadores es EXACTO usando solo
 * las tres normales de arista (30°, 90°, 150°), y sobre esas normales la
 * proyección de un hexágono mide justo su apotema (r·√3/2). Dos celdas se
 * solapan si y solo si se pisan en los tres ejes; `margen` exige además ese
 * aire entre bordes.
 */
const EJES = [30, 90, 150].map((g) => ({
  x: Math.cos((Math.PI / 180) * g),
  y: Math.sin((Math.PI / 180) * g),
}));

function sePisan(
  a: { x: number; y: number; r: number },
  b: { x: number; y: number; r: number },
  margen = 0,
): boolean {
  const tope = ((a.r + b.r) * Math.sqrt(3)) / 2 + margen;
  return EJES.every((u) => Math.abs((a.x - b.x) * u.x + (a.y - b.y) * u.y) < tope);
}

/**
 * Hexágono de esquinas redondeadas, que es la forma que usamos en toda la app
 * (el avatar del rail, la celda del panal). Cada vértice se recorta a `k` de
 * distancia sobre las dos aristas y se une con una curva cuyo control es el
 * vértice original: así la esquina queda mullida y no en pico.
 */
function hexRedondo(cx: number, cy: number, r: number, suavidad = 0.3): string {
  const v = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  // El lado de un hexágono mide lo mismo que su circunradio.
  const k = r * suavidad;
  const hacia = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / L) * k, y: p.y + (dy / L) * k };
  };
  const n = (i: number) => v[(i + 6) % 6];
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = hacia(n(i), n(i - 1));
    const b = hacia(n(i), n(i + 1));
    d += `${i === 0 ? `M ${a.x.toFixed(1)} ${a.y.toFixed(1)}` : `L ${a.x.toFixed(1)} ${a.y.toFixed(1)}`}`;
    d += ` Q ${n(i).x.toFixed(1)} ${n(i).y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)} `;
  }
  return `${d}Z`;
}

/**
 * ¿Esto es un identificador y no algo legible? Los ids de NL Pearl y HubSpot
 * son hexadecimales largos; en la app no se muestra ninguno.
 */
export function esHash(v: string): boolean {
  const s = v.trim();
  return /^[0-9a-f]{16,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s);
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
  readonly panal = computed<Celda[]>(() => {
    const activos = this.vivos();
    const resto = this.dormidos();
    if (!activos.length && !resto.length) return [];

    const S = 46;
    const R_ACTIVO = S * 2.15;
    // El que atiende su canal manda: se lleva el hexágono más grande.
    const R_EN_USO = S * 2.45;
    /** Junta mínima entre bordes, para que el trazo no se monte. */
    const MORTERO = 6;

    // Los que están en uso primero: ocupan el mero centro del racimo.
    const grandes = [...activos].sort(
      (a, b) => Number(this.isAssigned(b)) - Number(this.isAssigned(a)),
    );

    /*
     * Los grandes van PEGADOS entre sí, en su propio racimo espiral: paso de
     * retícula = el que deja a dos celdas del radio mayor casi tocándose.
     * (Separar los grandes y meter chicos entre medio era justo lo que no
     * quería el usuario: el centro debe ser un bloque.)
     */
    const mayor = grandes.some((w) => this.isAssigned(w)) ? R_EN_USO : R_ACTIVO;
    const pasoGrande = (mayor * Math.sqrt(3) + MORTERO) / Math.sqrt(3);

    const celdas: Celda[] = [];
    for (const [i, w] of grandes.entries()) {
      const pos = espiral(3)[i];
      if (!pos) break;
      const { x, y } = aPixel(pos.q, pos.r, pasoGrande);
      const r = this.isAssigned(w) ? R_EN_USO : R_ACTIVO;
      celdas.push({
        w, x, y, r, activo: true, luz: 1,
        iniciales: iniciales(w.name), lineas: lineasDe(w.name),
        d: hexRedondo(x, y, r),
      });
    }
    const nucleo = celdas.map((c) => ({ x: c.x, y: c.y, r: c.r }));

    /*
     * Los dormidos abrazan el racimo por FUERA: candidatos en espiral sobre
     * la retícula chica, descartando por test de ejes separadores todo el que
     * pise un grande. Como entre dos grandes solo queda el mortero, ahí no
     * cabe ninguno — no hay chicos incrustados en el centro.
     */
    const libres = espiral(18)
      .map(({ q, r }) => aPixel(q, r, S))
      .filter((p) => nucleo.every((g) => !sePisan({ ...p, r: S }, g, 3)))
      .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));

    const ultima = libres[Math.min(resto.length, libres.length) - 1];
    const alcance = ultima ? Math.hypot(ultima.x, ultima.y) || 1 : 1;

    for (const [i, w] of resto.entries()) {
      const p = libres[i];
      if (!p) break;
      // Como en la referencia: la luz nace en el centro y se apaga hacia afuera.
      const dist = Math.hypot(p.x, p.y);
      celdas.push({
        w, x: p.x, y: p.y, r: S, activo: false,
        luz: Math.max(0.1, 1 - dist / (alcance * 1.2)),
        iniciales: iniciales(w.name), lineas: [],
        d: hexRedondo(p.x, p.y, S),
      });
    }
    return celdas;
  });

  /** viewBox que encuadra el panal completo, con aire para el resplandor. */
  readonly vista = computed(() => {
    const todas = this.panal();
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

  readonly selectedId = signal<string | null>(null);
  readonly flow = httpResource<WorkerFlow>(() =>
    this.selectedId() ? `/api/workers/${this.selectedId()}/flow` : undefined,
  );

  readonly selected = computed<Worker | null>(
    () => (this.data.value()?.workers ?? []).find((w) => w.id === this.selectedId()) ?? null,
  );

  /**
   * Pares clave/valor del detalle. Se descartan los identificadores internos
   * de NL Pearl: un hash de 24 caracteres no le dice nada a quien opera, y en
   * la app no mostramos ids en ningún lado.
   */
  readonly selectedDetails = computed<Array<{ key: string; value: string }>>(() => {
    const raw = this.selected()?.raw ?? {};
    return Object.entries(raw)
      .filter(([key]) => !['id', 'name'].includes(key) && !/id$/i.test(key))
      .filter(([, value]) => !esHash(String(value)))
      .slice(0, 12)
      .map(([key, value]) => ({ key, value: String(value) }));
  });

  /**
   * Nombre legible de un paso del flujo. Nunca el `nodeId`: es técnico y en
   * la app no se muestran identificadores.
   */
  pasoLegible(n: { label?: string; name?: string; id?: string }): string {
    const crudo = (n.label ?? n.name ?? '').trim();
    if (crudo && !esHash(crudo)) return crudo;
    // `collectLocation` → `Collect location`, que al menos se lee.
    const id = (n.id ?? '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (!id || esHash(id)) return 'Paso del flujo';
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

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
