import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AgenteResumen } from '../../models';
import { armarPanal } from '../../panal';
import { valorDe } from '../../recurso';

/** Herramientas que trae el motor y no dicen nada del trabajo del agente. */
const DE_SISTEMA = ['end_call', 'language_detection'];

/**
 * Los agentes que atienden: crear, configurar y probar sin salir de acá.
 *
 * Vive en la consola y no en el panel del proveedor por dos razones: el equipo
 * que escribe lo que dice el agente no debería necesitar credenciales de
 * ElevenLabs, y lo que hace el agente —abrir tickets, avisar a la cuadrilla—
 * se define de este lado.
 *
 * Se ven como un PANAL y no como una rejilla de tarjetas: es la forma de la
 * marca y la que ya tenía esta pantalla. El tamaño de cada celda dice algo —el
 * que contesta hoy manda, los configurados van en grande, los borradores
 * chicos alrededor—, que es justo lo que una rejilla de tarjetas iguales no
 * puede decir.
 */
@Component({
  selector: 'app-agentes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './agentes.html',
  styleUrl: './agentes.scss',
})
export class AgentesPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly datos = httpResource<{ configurado: boolean; agentes: AgenteResumen[] }>(() => '/api/agentes');

  readonly creando = signal(false);
  readonly nombreNuevo = signal('');
  readonly error = signal<string | null>(null);

  readonly agentes = computed(() => valorDe(this.datos)?.agentes ?? []);

  /**
   * Un agente "armado" tiene con qué trabajar: herramientas propias.
   *
   * Es la única señal real que da el proveedor —no hay encendido/apagado—, y
   * alcanza para lo que importa acá: distinguir el que atiende de los que
   * quedaron a medio hacer.
   */
  readonly armados = computed(() => this.agentes().filter((a) => this.propias(a) > 0 || a.enUso));
  readonly borradores = computed(() => this.agentes().filter((a) => !this.propias(a) && !a.enUso));

  readonly panal = computed(() =>
    armarPanal(this.agentes(), {
      nombre: (a) => a.nombre,
      grande: (a) => this.propias(a) > 0 || a.enUso,
      principal: (a) => a.enUso,
    }),
  );

  readonly seleccionado = signal<string | null>(null);
  readonly agente = computed<AgenteResumen | null>(
    () => this.agentes().find((a) => a.id === this.seleccionado()) ?? null,
  );

  seleccionar(id: string): void {
    this.seleccionado.set(this.seleccionado() === id ? null : id);
  }

  escribirNombre(e: Event): void {
    this.nombreNuevo.set((e.target as HTMLInputElement).value);
  }

  /**
   * Un agente nuevo nace con instrucciones mínimas y sin herramientas.
   *
   * A propósito: se crea y se va DIRECTO al editor, que es donde se decide qué
   * dice y qué puede hacer. Un formulario largo antes de ver nada sería pedirle
   * al operador que escriba a ciegas.
   */
  async crear(): Promise<void> {
    const nombre = this.nombreNuevo().trim();
    if (!nombre || this.creando()) return;
    this.creando.set(true);
    this.error.set(null);
    try {
      const { id } = await this.api.crearAgente(nombre);
      await this.router.navigate(['/agentes', id]);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.creando.set(false);
    }
  }

  /** Cuántas herramientas de verdad tiene, sin contar las de sistema. */
  propias(a: AgenteResumen): number {
    return a.herramientas.filter((h) => !DE_SISTEMA.includes(h)).length;
  }

  /** Las herramientas propias, con nombre legible, para el lateral. */
  herramientasDe(a: AgenteResumen): string[] {
    return a.herramientas.filter((h) => !DE_SISTEMA.includes(h)).map((h) => h.replace(/_/g, ' '));
  }

  /** Qué atiende: es lo que va bajo el nombre en la celda grande. */
  canalDe(a: AgenteResumen): string {
    return a.soloTexto ? 'Texto' : 'Voz y texto';
  }

  /**
   * El idioma en palabras. El proveedor lo da como código —"es"—, y un código
   * de dos letras en una píldora no le dice nada a quien opera.
   */
  idiomaDe(a: AgenteResumen): string {
    const nombres: Record<string, string> = { es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés' };
    return nombres[a.idioma?.toLowerCase()] ?? a.idioma;
  }
}
