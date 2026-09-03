import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AgenteDetalle, HerramientaDisponible } from '../../models';
import { valorDe } from '../../recurso';

/** Un turno del banco de pruebas. */
interface TurnoPrueba {
  de: 'persona' | 'agente';
  texto: string;
  /** Lo que el agente HARÍA en producción: acá solo se reporta. */
  herramientas?: Array<{ nombre: string; args: Record<string, unknown> }>;
}

/**
 * Editor de un agente: lo que dice, lo que puede hacer y cómo responde.
 *
 * Las tres cosas en una pantalla a propósito. Configurar un agente es un ciclo
 * corto —cambiar una línea del prompt, probar, volver a cambiar— y partirlo en
 * pestañas obliga a recordar qué se tocó entre una y otra.
 */
@Component({
  selector: 'app-agente-detalle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './agente-detalle.html',
  styleUrl: './agente-detalle.scss',
})
export class AgenteDetallePage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  readonly agente = httpResource<AgenteDetalle>(() => `/api/agentes/${this.id()}`);
  readonly catalogo = httpResource<HerramientaDisponible[]>(() => '/api/agentes/herramientas');

  /* --- Borrador: lo editado todavía sin guardar --- */
  readonly instrucciones = signal('');
  readonly primerMensaje = signal('');
  readonly soloTexto = signal(false);
  readonly enganchadas = signal<Set<string>>(new Set());

  readonly guardando = signal(false);
  readonly aviso = signal<string | null>(null);

  constructor() {
    /*
     * El borrador se siembra cuando llega el agente, una sola vez por carga.
     * Sin el guardado, cada refresco del recurso pisaría lo que el operador
     * está escribiendo — que es la peor forma de perder trabajo.
     */
    effect(() => {
      const a = valorDe(this.agente);
      if (!a || this.sembrado) return;
      this.sembrado = true;
      this.instrucciones.set(a.instrucciones);
      this.primerMensaje.set(a.primerMensaje);
      this.soloTexto.set(a.soloTexto);
      this.enganchadas.set(new Set(a.herramientas));
    });
  }
  private sembrado = false;

  /** Solo las que ejecuta nuestra app: las de sistema no se eligen acá. */
  readonly herramientas = computed(() => valorDe(this.catalogo) ?? []);

  readonly hayCambios = computed(() => {
    const a = valorDe(this.agente);
    if (!a) return false;
    /*
     * Solo las del catálogo, de los dos lados. El agente también trae las de
     * sistema (end_call, language_detection), que no se eligen acá: contarlas
     * hacía que la pantalla dijera "cambios sin guardar" desde que se abría,
     * sin haber tocado nada — y ese aviso deja de significar algo enseguida.
     */
    const antes = a.herramientas.filter((h) => this.esPropia(h)).sort().join('|');
    const ahora = [...this.enganchadas()].filter((h) => this.esPropia(h)).sort().join('|');
    return (
      a.instrucciones !== this.instrucciones() ||
      a.primerMensaje !== this.primerMensaje() ||
      a.soloTexto !== this.soloTexto() ||
      antes !== ahora
    );
  });

  private esPropia(nombre: string): boolean {
    return this.herramientas().some((h) => h.nombre === nombre);
  }

  escribirInstrucciones(e: Event): void {
    this.instrucciones.set((e.target as HTMLTextAreaElement).value);
  }
  escribirPrimerMensaje(e: Event): void {
    this.primerMensaje.set((e.target as HTMLInputElement).value);
  }
  alternarSoloTexto(): void {
    this.soloTexto.update((v) => !v);
  }

  alternarHerramienta(nombre: string): void {
    this.enganchadas.update((s) => {
      const copia = new Set(s);
      copia.has(nombre) ? copia.delete(nombre) : copia.add(nombre);
      return copia;
    });
  }

  async guardar(): Promise<void> {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.aviso.set(null);
    try {
      await this.api.actualizarAgente(this.id(), {
        instrucciones: this.instrucciones(),
        primerMensaje: this.primerMensaje(),
        soloTexto: this.soloTexto(),
        herramientas: [...this.enganchadas()].filter((h) => this.esPropia(h)),
      });
      this.aviso.set('Guardado.');
      this.agente.reload();
    } catch (e) {
      this.aviso.set((e as Error).message);
    } finally {
      this.guardando.set(false);
    }
  }

  /* --- Banco de pruebas --- */

  readonly conversacion = signal<TurnoPrueba[]>([]);
  readonly mensaje = signal('');
  readonly probando = signal(false);

  escribirMensaje(e: Event): void {
    this.mensaje.set((e.target as HTMLInputElement).value);
  }

  /**
   * Habla con el agente tal como está GUARDADO, no como está en pantalla.
   *
   * Se avisa cuando hay cambios sin guardar en vez de guardarlos solos: el
   * agente en uso atiende ciudadanos de verdad, y un guardado implícito por
   * escribir en un chat de prueba sería un cambio en producción que nadie pidió.
   */
  async enviar(): Promise<void> {
    const texto = this.mensaje().trim();
    if (!texto || this.probando()) return;

    const historial = this.conversacion().map((t) => ({ de: t.de, texto: t.texto }));
    this.conversacion.update((c) => [...c, { de: 'persona', texto }]);
    this.mensaje.set('');
    this.probando.set(true);
    try {
      const r = await this.api.probarAgente(this.id(), texto, historial);
      this.conversacion.update((c) => [
        ...c,
        {
          de: 'agente',
          texto: r.respuesta ?? '(el agente no contestó)',
          herramientas: r.herramientas,
        },
      ]);
    } catch (e) {
      this.conversacion.update((c) => [...c, { de: 'agente', texto: `⚠ ${(e as Error).message}` }]);
    } finally {
      this.probando.set(false);
    }
  }

  limpiarPrueba(): void {
    this.conversacion.set([]);
  }

  /**
   * Los argumentos con los que llamó la herramienta, legibles.
   *
   * En JSON crudo la parte que importa —qué ubicación entendió, qué riesgo
   * puso— queda enterrada entre llaves y comillas, y es justo lo que se está
   * evaluando al probar.
   */
  argumentos(args: Record<string, unknown>): string {
    return Object.entries(args)
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
      .join(' · ');
  }

  /* --- Contexto --- */

  readonly tituloContexto = signal('');
  readonly textoContexto = signal('');
  readonly subiendo = signal(false);

  escribirTitulo(e: Event): void {
    this.tituloContexto.set((e.target as HTMLInputElement).value);
  }
  escribirTexto(e: Event): void {
    this.textoContexto.set((e.target as HTMLTextAreaElement).value);
  }

  async agregarContexto(): Promise<void> {
    const titulo = this.tituloContexto().trim();
    const texto = this.textoContexto().trim();
    if (!titulo || !texto || this.subiendo()) return;
    this.subiendo.set(true);
    try {
      await this.api.agregarContextoAgente(this.id(), titulo, texto);
      this.tituloContexto.set('');
      this.textoContexto.set('');
      this.aviso.set(`Contexto "${titulo}" agregado.`);
      this.agente.reload();
    } catch (e) {
      this.aviso.set((e as Error).message);
    } finally {
      this.subiendo.set(false);
    }
  }

  /* --- Duplicar y borrar --- */

  async duplicar(): Promise<void> {
    const a = valorDe(this.agente);
    if (!a) return;
    try {
      const { id } = await this.api.duplicarAgente(this.id(), `${a.nombre} (copia)`);
      await this.router.navigate(['/agentes', id]);
    } catch (e) {
      this.aviso.set((e as Error).message);
    }
  }

  readonly confirmandoBorrado = signal(false);

  async eliminar(): Promise<void> {
    // Dos pasos: borrar un agente se lleva su prompt y su contexto, y no hay
    // papelera de la que sacarlo.
    if (!this.confirmandoBorrado()) {
      this.confirmandoBorrado.set(true);
      return;
    }
    try {
      await this.api.eliminarAgente(this.id());
      await this.router.navigate(['/agentes']);
    } catch (e) {
      this.aviso.set((e as Error).message);
      this.confirmandoBorrado.set(false);
    }
  }
}
