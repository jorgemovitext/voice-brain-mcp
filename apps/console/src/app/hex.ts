/**
 * La forma de la marca: hexágonos de esquinas redondeadas.
 *
 * Vive acá y no en una vista porque la usan el panal de Agentes y el árbol
 * del flujo, y son la MISMA forma — si una se retoca sin la otra, la app
 * empieza a tener dos hexágonos distintos.
 *
 * La técnica es común a las tres funciones: cada vértice se recorta a `k` de
 * distancia sobre sus dos aristas y se une con una curva cuadrática cuyo
 * control es el vértice original. Así la esquina queda mullida y no en pico,
 * sin depender de `stroke-linejoin` (que solo redondea el trazo, no el
 * relleno).
 */

/** Une una lista de vértices redondeando cada esquina a `k` de distancia. */
function unirRedondeando(v: Array<{ x: number; y: number }>, k: number): string {
  const n = (i: number) => v[(i + v.length) % v.length];
  const hacia = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const L = Math.hypot(dx, dy) || 1;
    // Nunca más de la mitad del lado: si no, los recortes de dos vértices
    // vecinos se cruzan y la figura se dobla sobre sí misma.
    const r = Math.min(k, L / 2);
    return { x: p.x + (dx / L) * r, y: p.y + (dy / L) * r };
  };

  let d = '';
  for (let i = 0; i < v.length; i++) {
    const a = hacia(n(i), n(i - 1));
    const b = hacia(n(i), n(i + 1));
    d += i === 0 ? `M ${a.x.toFixed(1)} ${a.y.toFixed(1)}` : `L ${a.x.toFixed(1)} ${a.y.toFixed(1)}`;
    d += ` Q ${n(i).x.toFixed(1)} ${n(i).y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)} `;
  }
  return `${d}Z`;
}

/** Hexágono regular: el avatar del rail, la celda del panal. */
export function hexRedondo(cx: number, cy: number, r: number, suavidad = 0.16): string {
  const v = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  // El lado de un hexágono mide lo mismo que su circunradio.
  return unirRedondeando(v, r * suavidad);
}

/**
 * El mismo hexágono estirado a lo ancho, para cuando adentro va una etiqueta.
 * Mantiene las puntas laterales —lo que lo hace leer como hexágono y no como
 * píldora— con los cortes a `c` de cada lado.
 */
export function hexAlargado(cx: number, cy: number, w: number, h: number, c = 15): string {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const v = [
    { x: x + c, y },
    { x: x + w - c, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w - c, y: y + h },
    { x: x + c, y: y + h },
    { x, y: y + h / 2 },
  ];
  return unirRedondeando(v, h * 0.22);
}

/** Rombo de decisión, redondeado con el mismo criterio que los hexágonos. */
export function romboRedondo(cx: number, cy: number, w: number, h: number): string {
  const v = [
    { x: cx, y: cy - h / 2 },
    { x: cx + w / 2, y: cy },
    { x: cx, y: cy + h / 2 },
    { x: cx - w / 2, y: cy },
  ];
  return unirRedondeando(v, h * 0.26);
}
