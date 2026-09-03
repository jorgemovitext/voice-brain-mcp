import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AristaFlujo, HerramientaDisponible, NodoFlujo } from '../../models';
import { valorDe } from '../../recurso';

/** Ancho y alto de una caja, para el dibujo y para el enganche de las flechas. */
const ANCHO = 168;
const ALTO = 64;

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
    // Curva con tirantes horizontales: dos cajas en la misma línea se unen con
    // una recta, y una que quedó arriba o abajo no cruza por encima del texto.
    const tiron = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + tiron} ${y1}, ${x2 - tiron} ${y2}, ${x2} ${y2}`;
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
    return { ancho, alto, vista: `0 0 ${ancho} ${alto}` };
  });

  /**
   * El texto sobre la flecha va corto a propósito: el hueco entre dos cajas es
   * angosto y una condición larga se monta encima. Completa se lee en el panel
   * de la derecha al seleccionarla.
   */
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
