import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AristaFlujo, HerramientaDisponible, NodoFlujo } from '../../models';
import { valorDe } from '../../recurso';

/** Ancho y alto de una caja, para el dibujo y para el enganche de las flechas. */
const ANCHO = 208;
const ALTO = 112;

/**
 * El flujo de la conversación, dibujado.
 *
 * Un prompt largo describe mal el orden: "no registres hasta tener la
 * ubicación" es una frase que el modelo puede saltarse. Acá eso es estructura
 * —una fase no lleva a la siguiente hasta que se cumple la condición—, y se ve
 * de un vistazo en vez de leerse entre veinte líneas de instrucciones.
 *
 * Se dibuja con SVG y no con una librería de grafos: son cuatro tipos de caja
 * y flechas rectas, y traer un motor de diagramas para eso pesaría más que la
 * consola entera.
 */
@Component({
  selector: 'app-agente-flujo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './agente-flujo.html',
  styleUrl: './agente-flujo.scss',
})
export class AgenteFlujoPage {
  protected readonly valorDe = valorDe;
  protected readonly ANCHO = ANCHO;
  protected readonly ALTO = ALTO;

  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  readonly datos = httpResource<{ nodos: NodoFlujo[]; aristas: AristaFlujo[] }>(
    () => `/api/agentes/${this.id()}/flujo`,
  );
  readonly agente = httpResource<{ nombre: string }>(() => `/api/agentes/${this.id()}`);
  readonly catalogo = httpResource<HerramientaDisponible[]>(() => '/api/agentes/herramientas');

  readonly nodos = signal<NodoFlujo[]>([]);
  readonly aristas = signal<AristaFlujo[]>([]);
  readonly guardando = signal(false);
  readonly aviso = signal<string | null>(null);

  private sembrado = false;

  constructor() {
    effect(() => {
      const d = valorDe(this.datos);
      if (!d || this.sembrado) return;
      this.sembrado = true;
      this.nodos.set(d.nodos.map((n) => ({ ...n })));
      this.aristas.set(d.aristas.map((a) => ({ ...a })));
    });
  }

  readonly herramientas = computed(() => valorDe(this.catalogo) ?? []);

  /**
   * Cómo se llama una caja en pantalla.
   *
   * Solo las fases guardan nombre propio en el proveedor. Para una acción el
   * nombre útil es lo que ejecuta —"registrar_reporte + asignar_tarea"—, que
   * además no se puede desincronizar de lo que hace.
   */
  titulo(n: NodoFlujo): string {
    if (n.tipo === 'inicio') return 'Inicio';
    if (n.tipo === 'fin') return 'Fin';
    if (n.tipo === 'accion') return n.herramientas?.length ? n.herramientas.join(' + ') : 'Sin herramientas';
    return n.nombre || 'Fase sin nombre';
  }

  /** El glifo del azulejo. Dice el tipo sin leer, como el ícono de una app. */
  glifo(n: NodoFlujo): string {
    if (n.tipo === 'inicio') return '▷';
    if (n.tipo === 'fin') return '□';
    if (n.tipo === 'accion') return '⚙';
    return '◈';
  }

  /**
   * Qué ES esta caja, bajo el nombre.
   *
   * En una fase, sus herramientas: es lo que de verdad la distingue de otra
   * fase del mismo alto. Sin herramientas, el tipo a secas.
   */
  rol(n: NodoFlujo): string {
    if (n.tipo === 'inicio') return 'Entrada';
    if (n.tipo === 'fin') return 'Cierre';
    if (n.tipo === 'accion') return 'Acción';
    return n.herramientas?.length ? n.herramientas.join(' · ') : 'Fase de la conversación';
  }

  /* --- Selección y edición --- */

  readonly seleccion = signal<string | null>(null);
  readonly seleccionArista = signal<string | null>(null);

  readonly nodoSeleccionado = computed(() => this.nodos().find((n) => n.id === this.seleccion()) ?? null);
  readonly aristaSeleccionada = computed(
    () => this.aristas().find((a) => a.id === this.seleccionArista()) ?? null,
  );

  seleccionar(id: string): void {
    this.seleccionArista.set(null);
    this.seleccion.set(id);
  }

  seleccionarArista(id: string): void {
    this.seleccion.set(null);
    this.seleccionArista.set(id);
  }

  private cambiarNodo(id: string, cambio: Partial<NodoFlujo>): void {
    this.nodos.update((ns) => ns.map((n) => (n.id === id ? { ...n, ...cambio } : n)));
  }

  renombrar(e: Event): void {
    const n = this.nodoSeleccionado();
    if (n) this.cambiarNodo(n.id, { nombre: (e.target as HTMLInputElement).value });
  }

  cambiarInstrucciones(e: Event): void {
    const n = this.nodoSeleccionado();
    if (n) this.cambiarNodo(n.id, { instrucciones: (e.target as HTMLTextAreaElement).value });
  }

  cambiarEntrada(e: Event): void {
    const n = this.nodoSeleccionado();
    if (n) this.cambiarNodo(n.id, { alEntrar: (e.target as HTMLSelectElement).value });
  }

  alternarHerramienta(nombre: string): void {
    const n = this.nodoSeleccionado();
    if (!n) return;
    const actuales = n.herramientas ?? [];
    this.cambiarNodo(n.id, {
      herramientas: actuales.includes(nombre)
        ? actuales.filter((h) => h !== nombre)
        : [...actuales, nombre],
    });
  }

  tiene(n: NodoFlujo, nombre: string): boolean {
    return (n.herramientas ?? []).includes(nombre);
  }

  cambiarCondicion(e: Event): void {
    const a = this.aristaSeleccionada();
    if (!a) return;
    const condicion = (e.target as HTMLInputElement).value;
    this.aristas.update((as) => as.map((x) => (x.id === a.id ? { ...x, condicion } : x)));
  }

  /* --- Agregar, conectar y borrar --- */

  private nuevoId(prefijo: string): string {
    // Determinista dentro de la sesión y legible en el JSON del proveedor.
    return `${prefijo}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  }

  agregar(tipo: 'fase' | 'accion' | 'fin'): void {
    const existentes = this.nodos();
    // A la derecha del último, en la misma línea: el flujo se lee de izquierda
    // a derecha y una caja que aparece encima de otra hay que ir a buscarla.
    const x = existentes.length ? Math.max(...existentes.map((n) => n.x)) + ANCHO + 60 : 40;
    const nodo: NodoFlujo = {
      id: this.nuevoId(tipo),
      tipo,
      nombre: tipo === 'fase' ? 'Fase nueva' : '',
      x,
      y: 140,
      instrucciones: '',
      herramientas: [],
      alEntrar: 'auto',
    };
    this.nodos.update((ns) => [...ns, nodo]);
    this.seleccionar(nodo.id);
  }

  /**
   * Acomoda las cajas de izquierda a derecha según la distancia al inicio.
   *
   * Los flujos hechos en el panel del proveedor llegan con todas las cajas en
   * la misma columna, y así las flechas se cruzan sobre el texto y no se
   * entiende el orden. Esto no toca el contenido: solo mueve, y no se guarda
   * hasta que se aprieta Guardar.
   */
  ordenar(): void {
    const ns = this.nodos();
    const as = this.aristas();
    const inicio = ns.find((n) => n.tipo === 'inicio') ?? ns[0];
    if (!inicio) return;

    // Distancia en saltos desde el inicio: es la columna de cada caja.
    const nivel = new Map<string, number>([[inicio.id, 0]]);
    let cola = [inicio.id];
    while (cola.length) {
      const siguiente: string[] = [];
      for (const id of cola) {
        for (const a of as.filter((x) => x.desde === id)) {
          if (nivel.has(a.hasta)) continue;
          nivel.set(a.hasta, (nivel.get(id) ?? 0) + 1);
          siguiente.push(a.hasta);
        }
      }
      cola = siguiente;
    }

    // Las que no cuelgan de nada quedan en una columna al final, visibles: son
    // justo las que hay que revisar.
    const maximo = Math.max(0, ...[...nivel.values()]);
    const porColumna = new Map<number, number>();
    this.nodos.update((lista) =>
      lista.map((n) => {
        const col = nivel.get(n.id) ?? maximo + 1;
        const fila = porColumna.get(col) ?? 0;
        porColumna.set(col, fila + 1);
        return { ...n, x: 40 + col * (ANCHO + 150), y: 40 + fila * (ALTO + 70) };
      }),
    );
  }

  /** Origen elegido mientras se traza una conexión. */
  readonly conectandoDesde = signal<string | null>(null);

  conectar(id: string): void {
    const desde = this.conectandoDesde();
    if (!desde) {
      this.conectandoDesde.set(id);
      return;
    }
    if (desde === id) {
      this.conectandoDesde.set(null);
      return;
    }
    const ya = this.aristas().some((a) => a.desde === desde && a.hasta === id);
    if (!ya) {
      this.aristas.update((as) => [...as, { id: this.nuevoId('e'), desde, hasta: id, condicion: '' }]);
    }
    this.conectandoDesde.set(null);
  }

  borrarNodo(): void {
    const n = this.nodoSeleccionado();
    if (!n || n.tipo === 'inicio') return;
    // Las flechas que lo tocaban se van con él: dejarlas colgando rompe el grafo.
    this.aristas.update((as) => as.filter((a) => a.desde !== n.id && a.hasta !== n.id));
    this.nodos.update((ns) => ns.filter((x) => x.id !== n.id));
    this.seleccion.set(null);
  }

  borrarArista(): void {
    const a = this.aristaSeleccionada();
    if (!a) return;
    this.aristas.update((as) => as.filter((x) => x.id !== a.id));
    this.seleccionArista.set(null);
  }

  /* --- Arrastrar --- */

  private arrastrando: { id: string; dx: number; dy: number } | null = null;

  empezarArrastre(e: PointerEvent, n: NodoFlujo): void {
    /*
     * Seleccionar va PRIMERO y sin depender de nada.
     *
     * Estaba al final, después de calcular el arrastre y de tomar el puntero:
     * cualquier fallo ahí —un `ownerSVGElement` nulo, un `setPointerCapture`
     * que el navegador rechaza— se llevaba también la selección, y tocar una
     * caja no hacía absolutamente nada. Seleccionar es lo que el usuario
     * siempre quiso; arrastrar es lo que quizás quiera después.
     */
    this.seleccionar(n.id);

    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    if (!svg) return;
    const p = this.aCoordenadas(e, svg);
    this.arrastrando = { id: n.id, dx: p.x - n.x, dy: p.y - n.y };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // Sin captura el arrastre sigue andando mientras el puntero esté encima;
      // solo se pierde si se sale del lienzo. No vale romper el turno por eso.
    }
  }

  moverArrastre(e: PointerEvent): void {
    if (!this.arrastrando) return;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement);
    const p = this.aCoordenadas(e, svg);
    this.cambiarNodo(this.arrastrando.id, {
      x: Math.max(0, Math.round(p.x - this.arrastrando.dx)),
      y: Math.max(0, Math.round(p.y - this.arrastrando.dy)),
    });
  }

  terminarArrastre(): void {
    this.arrastrando = null;
  }

  /** De píxeles de pantalla al sistema del SVG: el lienzo puede estar escalado. */
  private aCoordenadas(e: PointerEvent, svg: SVGSVGElement): { x: number; y: number } {
    const caja = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const escalaX = vb.width ? vb.width / caja.width : 1;
    const escalaY = vb.height ? vb.height / caja.height : 1;
    return { x: (e.clientX - caja.left) * escalaX, y: (e.clientY - caja.top) * escalaY };
  }

  /* --- Dibujo de las flechas --- */

  /** De borde derecho del origen a borde izquierdo del destino. */
  camino(a: AristaFlujo): string {
    const d = this.nodos().find((n) => n.id === a.desde);
    const h = this.nodos().find((n) => n.id === a.hasta);
    if (!d || !h) return '';
    const x1 = d.x + ANCHO;
    const y1 = d.y + ALTO / 2;
    const x2 = h.x;
    const y2 = h.y + ALTO / 2;

    /*
     * En ÁNGULO RECTO, no en curva.
     *
     * Con curvas, cuatro salidas de una misma fase salen del mismo punto en
     * abanico y a mitad de camino ya no se sabe cuál va a dónde — que es
     * exactamente el caso del flujo real, donde el saludo se bifurca en
     * cuatro. Las rectas se separan enseguida y cada codo dice dónde dobla.
     */
    if (Math.abs(y1 - y2) < 2) return `M ${x1} ${y1} H ${x2}`;

    const m = (x1 + x2) / 2;
    const r = 12;
    const baja = y2 > y1 ? 1 : -1;
    // El radio nunca puede pasarse de la mitad del tramo, o el codo se dobla
    // sobre sí mismo cuando dos cajas quedan casi pegadas.
    const rx = Math.min(r, Math.abs(m - x1), Math.abs(x2 - m));
    const ry = Math.min(r, Math.abs(y2 - y1) / 2);
    return [
      `M ${x1} ${y1}`,
      `H ${m - rx}`,
      `Q ${m} ${y1} ${m} ${y1 + baja * ry}`,
      `V ${y2 - baja * ry}`,
      `Q ${m} ${y2} ${m + rx} ${y2}`,
      `H ${x2}`,
    ].join(' ');
  }

  /**
   * La condición, con la flecha adelante.
   *
   * El glifo no es adorno: la píldora flota sobre la línea y sin él se lee
   * como el rótulo de una caja. Con la flecha se lee como lo que es — por
   * dónde se sale de acá.
   */
  etiquetaCond(condicion: string): string {
    return `↗ ${this.recorte(condicion, 22)}`;
  }

  /** Punto medio de la flecha, donde va la etiqueta de la condición. */
  medio(a: AristaFlujo): { x: number; y: number } | null {
    const d = this.nodos().find((n) => n.id === a.desde);
    const h = this.nodos().find((n) => n.id === a.hasta);
    if (!d || !h) return null;
    return { x: (d.x + ANCHO + h.x) / 2, y: (d.y + h.y) / 2 + ALTO / 2 - 8 };
  }

  /** El lienzo crece con el contenido: si no, arrastrar a la derecha lo corta. */
  readonly lienzo = computed(() => {
    const ns = this.nodos();
    const ancho = Math.max(900, ...ns.map((n) => n.x + ANCHO + 80));
    const alto = Math.max(420, ...ns.map((n) => n.y + ALTO + 80));
    const z = this.zoom();
    // El viewBox no cambia: se escala el tamaño dibujado, así las coordenadas
    // del arrastre siguen siendo las del modelo y no hay que convertirlas.
    return { ancho: ancho * z, alto: alto * z, vista: `0 0 ${ancho} ${alto}` };
  });

  /**
   * El texto sobre la flecha va corto a propósito: el hueco entre dos cajas es
   * angosto y una condición larga se monta encima. Completa se lee en el panel
   * de la derecha al seleccionarla.
   */
  /**
   * Las salidas de un nodo, en el orden en que se evalúan.
   *
   * La primera condición que se cumple gana: si "quiere reportar un problema"
   * se evalúa antes que "hay alguien en peligro", una emergencia entra por la
   * rama tranquila. Por eso el orden se edita, no se deja al azar del dibujo.
   */
  readonly salidas = computed(() => {
    const n = this.nodoSeleccionado();
    if (!n) return [];
    const suyas = this.aristas().filter((a) => a.desde === n.id);
    const orden = n.orden ?? [];
    return [...suyas].sort((a, b) => {
      const ia = orden.indexOf(a.id);
      const ib = orden.indexOf(b.id);
      // Las que no están en el orden guardado van al final, en su orden natural.
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  });

  /** Sube o baja una salida en la evaluación. */
  moverSalida(id: string, delta: number): void {
    const n = this.nodoSeleccionado();
    if (!n) return;
    const ids = this.salidas().map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.cambiarNodo(n.id, { orden: ids });
  }

  /** A dónde lleva una salida, para nombrarla en la lista. */
  destino(a: AristaFlujo): string {
    const n = this.nodos().find((x) => x.id === a.hasta);
    return n ? this.titulo(n) : '?';
  }

  /** Las primeras líneas de las instrucciones, para la tarjeta del lienzo. */
  vistaPrevia(n: NodoFlujo): string {
    if (n.tipo === 'accion') return (n.herramientas ?? []).join(', ') || 'Sin herramientas';
    if (n.tipo === 'inicio') return 'Punto de entrada de toda conversación';
    if (n.tipo === 'fin') return 'Termina la conversación';
    return (n.instrucciones ?? '').replace(/\s+/g, ' ').trim() || 'Sin instrucciones propias';
  }

  /** Cuántas salidas tiene: con más de una, el orden de evaluación importa. */
  salidasDe(n: NodoFlujo): number {
    return this.aristas().filter((a) => a.desde === n.id).length;
  }

  /** Cuántas herramientas tiene: el chip del pie de la tarjeta. */
  cuantasHerramientas(n: NodoFlujo): number {
    return (n.herramientas ?? []).length;
  }

  /* --- Zoom --- */

  readonly zoom = signal(1);

  acercar(paso: number): void {
    // Topes anchos pero finitos: con menos de 0.4 no se lee y con más de 2 se
    // pierde de vista el resto del flujo, que es justo lo que se viene a ver.
    this.zoom.update((z) => Math.min(2, Math.max(0.4, +(z + paso).toFixed(2))));
  }

  ajustar(): void {
    this.zoom.set(1);
    this.ordenar();
  }

  recorte(t: string, n = 34): string {
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  /* --- Guardar --- */

  readonly problemas = computed(() => {
    const ns = this.nodos();
    const as = this.aristas();
    const avisos: string[] = [];

    const sueltos = ns.filter(
      (n) => n.tipo !== 'inicio' && !as.some((a) => a.hasta === n.id),
    );
    if (sueltos.length) {
      avisos.push(`${sueltos.map((n) => this.titulo(n)).join(', ')}: nada lleva hasta ahí.`);
    }
    const faseSinNombre = ns.some((n) => n.tipo === 'fase' && !n.nombre?.trim());
    if (faseSinNombre) avisos.push('Hay una fase sin nombre; el proveedor la rechaza.');
    return avisos;
  });

  async guardar(): Promise<void> {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.aviso.set(null);
    try {
      await this.api.guardarFlujoAgente(this.id(), { nodos: this.nodos(), aristas: this.aristas() });
      this.aviso.set('Flujo guardado.');
    } catch (e) {
      this.aviso.set((e as Error).message);
    } finally {
      this.guardando.set(false);
    }
  }
}
