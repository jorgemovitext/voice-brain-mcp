import { hexRedondo } from './hex';

/**
 * El panal: cómo se acomodan los hexágonos de la vista de Agentes.
 *
 * Vive aparte de la vista porque es geometría, no producto: acá no hay nada
 * que sepa qué es un agente. La vista dice cuáles van grandes y con qué
 * nombre; esto devuelve dónde va cada celda y el encuadre que las contiene.
 */

/** Una celda ya resuelta a coordenadas de pantalla. */
export interface CeldaPanal<T> {
  item: T;
  /** Centro del hexágono, en unidades del viewBox. */
  x: number;
  y: number;
  /** Circunradio: la mitad del ancho del hexágono. */
  r: number;
  grande: boolean;
  /** Brillo del borde, 0..1. Cae con la distancia al centro, como en un panal. */
  luz: number;
  iniciales: string;
  /** Nombre partido en 1–2 líneas que caben dentro del hexágono grande. */
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
 * Dónde va el siguiente hexágono grande: pegado a alguno de los ya puestos,
 * en la primera de las seis direcciones que no choque. Con radios distintos
 * una retícula de paso fijo dejaría al más chico flotando, así que la
 * distancia se calcula por par: (R₁+R₂)·√3/2 más la junta.
 */
function ubicarGrande(
  puestos: Array<{ x: number; y: number; r: number }>,
  r: number,
  mortero: number,
): { x: number; y: number } {
  if (!puestos.length) return { x: 0, y: 0 };
  // Normales de arista: es por donde dos hexágonos de lado plano se besan.
  const DIRS = [30, 90, 150, 210, 270, 330].map((g) => ({
    x: Math.cos((Math.PI / 180) * g),
    y: Math.sin((Math.PI / 180) * g),
  }));
  for (const base of puestos) {
    const paso = ((base.r + r) * Math.sqrt(3)) / 2 + mortero;
    for (const u of DIRS) {
      const p = { x: base.x + u.x * paso, y: base.y + u.y * paso, r };
      if (puestos.every((q) => !sePisan(p, q, mortero / 2))) return { x: p.x, y: p.y };
    }
  }
  // Sin sitio pegado: se cuelga arriba, lejos de todo.
  const alto = puestos.reduce((m, q) => Math.min(m, q.y - q.r), 0);
  return { x: 0, y: alto - r * 2 };
}

/** Dos letras para el hexágono chico, donde no cabe el nombre. */
export function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter((p) => /[a-záéíóúñ]/i.test(p[0] ?? ''));
  const dos = partes.slice(0, 2).map((p) => p[0]).join('');
  return (dos || nombre.slice(0, 2)).toUpperCase();
}

/**
 * Parte el nombre en hasta dos líneas de ~15 caracteres, que es lo que cabe
 * en la panza del hexágono grande sin tocar los bordes. Lo que no cabe se
 * corta con elipsis: el nombre completo va en el <title> de la celda.
 */
export function lineasDe(nombre: string): string[] {
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

/*
 * Los radios NO son a gusto: sobre esta retícula solo 2·S y 3·S encajan a
 * ras. Medido barriendo de 1.8 a 3.2, el hueco hasta la celda chica
 * superviviente más cercana es 0.00 en esos dos valores y sube hasta 0.69·S
 * en los intermedios — esos huecos son los espacios negros que se veían. Un
 * grande de 2·S se come 7 celdas (la suya y su anillo); uno de 3·S se come
 * 13, y sus propias esquinas rellenan lo que ocupaban.
 */
const S = 46;
const R_GRANDE = S * 2;
/** El principal manda: mitad más grande y a ras con sus vecinas. */
const R_PRINCIPAL = S * 3;
/** Junta mínima entre bordes, para que los trazos no se monten. */
const MORTERO = 3;

/**
 * Arma el panal: los grandes en racimo al centro, el resto abrazándolo.
 *
 * Se usan DOS retículas —una de paso grande para los del centro y otra de
 * paso chico para el resto— porque tamaños distintos no caben en una sola sin
 * solaparse. Los chicos empiezan donde termina el racimo central, así que el
 * mosaico se lee como un solo panal aunque por dentro sean dos.
 */
export function armarPanal<T>(
  items: T[],
  opciones: {
    nombre: (t: T) => string;
    /** Va en grande, al centro. */
    grande: (t: T) => boolean;
    /** El más grande de todos: el que atiende ahora mismo. */
    principal?: (t: T) => boolean;
  },
): { celdas: Array<CeldaPanal<T>>; box: string } {
  const principal = opciones.principal ?? (() => false);
  const centro = items.filter(opciones.grande);
  const resto = items.filter((t) => !opciones.grande(t));
  if (!centro.length && !resto.length) return { celdas: [], box: '0 0 100 100' };

  const celdas: Array<CeldaPanal<T>> = [];

  /*
   * Cada grande se coloca A RAS del anterior, en la primera de las seis
   * direcciones que quede libre. No se usa una retícula común porque los
   * radios son distintos: con un paso único, el grande pequeño quedaba
   * flotando a media celda de su vecino.
   */
  const nucleo: Array<{ x: number; y: number; r: number }> = [];
  // El principal primero: ocupa el mero centro del racimo.
  for (const t of [...centro].sort((a, b) => Number(principal(b)) - Number(principal(a)))) {
    const r = principal(t) ? R_PRINCIPAL : R_GRANDE;
    const donde = ubicarGrande(nucleo, r, MORTERO);
    nucleo.push({ ...donde, r });
    celdas.push({
      item: t, x: donde.x, y: donde.y, r, grande: true, luz: 1,
      iniciales: iniciales(opciones.nombre(t)), lineas: lineasDe(opciones.nombre(t)),
      d: hexRedondo(donde.x, donde.y, r),
    });
  }

  /*
   * Los chicos abrazan el racimo por FUERA: candidatos en espiral sobre la
   * retícula chica, descartando solo los que de verdad pisan un grande. El
   * margen es 0 — cualquier holgura extra se ve como hueco negro.
   *
   * El orden de llenado es elíptico, no circular: la distancia horizontal
   * cuenta un 60%, así que el panal crece antes a lo ancho que a lo alto. Con
   * orden circular salía un bloque casi cuadrado y en pantallas anchas sobraba
   * media pantalla vacía a cada lado.
   */
  const lejania = (p: { x: number; y: number }) => Math.hypot(p.x * 0.6, p.y);
  const libres = espiral(18)
    .map(({ q, r }) => aPixel(q, r, S))
    .filter((p) => nucleo.every((g) => !sePisan({ ...p, r: S }, g)))
    .sort((a, b) => lejania(a) - lejania(b));

  const ultima = libres[Math.min(resto.length, libres.length) - 1];
  const alcance = ultima ? Math.hypot(ultima.x, ultima.y) || 1 : 1;

  for (const [i, t] of resto.entries()) {
    const p = libres[i];
    if (!p) break;
    // La luz nace en el centro y se apaga hacia afuera.
    const dist = Math.hypot(p.x, p.y);
    celdas.push({
      item: t, x: p.x, y: p.y, r: S, grande: false,
      luz: Math.max(0.1, 1 - dist / (alcance * 1.2)),
      iniciales: iniciales(opciones.nombre(t)), lineas: [],
      d: hexRedondo(p.x, p.y, S),
    });
  }

  return { celdas, box: encuadre(celdas) };
}

/** viewBox que contiene el panal completo, con aire para el resplandor. */
function encuadre<T>(celdas: Array<CeldaPanal<T>>): string {
  if (!celdas.length) return '0 0 100 100';
  const m = celdas.reduce(
    (a, x) => ({
      x0: Math.min(a.x0, x.x - x.r),
      x1: Math.max(a.x1, x.x + x.r),
      y0: Math.min(a.y0, x.y - x.r),
      y1: Math.max(a.y1, x.y + x.r),
    }),
    { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
  );
  const aire = 26;
  return `${m.x0 - aire} ${m.y0 - aire} ${m.x1 - m.x0 + aire * 2} ${m.y1 - m.y0 + aire * 2}`;
}
