import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { ActividadAgente, AgenteResumen } from '../../models';
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

  readonly datos = httpResource<{ configurado: boolean; agentes: AgenteResumen[] }>(() => '/api/agentes');

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

  /* --- Lo que hizo el agente elegido ------------------------------------- */

  /**
   * Se pide al proveedor y no a nuestra base: nuestras interacciones guardan
   * quién atendió como ROL —«agente»—, no cuál de los agentes, así que no hay
   * forma de separar por agente de este lado.
   */
  readonly actividad = httpResource<ActividadAgente>(() =>
    this.seleccionado() ? `/api/agentes/${this.seleccionado()}/actividad` : undefined,
  );

  /* --- Ponerlo a atender --------------------------------------------------- */

  /**
   * Los reparos del agente que se está por poner a atender.
   *
   * `null` significa que todavía no se preguntó; un arreglo vacío, que se
   * preguntó y no hay nada que advertir. La distinción importa: con un solo
   * valor, "sin reparos" y "sin revisar" se verían igual y la confirmación
   * aparecería en blanco mientras carga.
   */
  readonly reparos = signal<Array<{ gravedad: string; texto: string }> | null>(null);
  readonly confirmando = signal<string | null>(null);
  readonly cambiando = signal(false);
  readonly resultado = signal<string | null>(null);
  readonly errorCambio = signal<string | null>(null);

  /** Abre la confirmación y va a buscar qué puede salir mal. */
  async proponerCambio(id: string): Promise<void> {
    this.confirmando.set(id);
    this.reparos.set(null);
    this.resultado.set(null);
    this.errorCambio.set(null);
    try {
      const r = await this.api.revisarAgente(id);
      this.reparos.set(r.reparos);
    } catch (e) {
      // Sin revisión no se confirma a ciegas: es un cambio en producción.
      this.errorCambio.set(`No se pudo revisar el agente: ${(e as Error).message}`);
      this.reparos.set([{ gravedad: 'bloqueo', texto: 'No se pudo revisar.' }]);
    }
  }

  cancelarCambio(): void {
    this.confirmando.set(null);
    this.reparos.set(null);
  }

  /** `bloqueo` no se puede forzar: el servidor lo rechaza igual. */
  readonly bloqueado = computed(() => (this.reparos() ?? []).some((r) => r.gravedad === 'bloqueo'));

  async confirmarCambio(): Promise<void> {
    const id = this.confirmando();
    if (!id || this.cambiando() || this.bloqueado()) return;

    this.cambiando.set(true);
    this.errorCambio.set(null);
    try {
      const r = await this.api.usarAgente(id);
      const numeros = r.numeros.length ? ` El teléfono ${r.numeros.join(' y ')} ahora cae ahí.` : '';
      this.resultado.set(r.aviso ?? `Ahora atiende «${r.nombre ?? 'el agente'}».${numeros}`);
      this.confirmando.set(null);
      this.reparos.set(null);
      // La marca de "en uso" sale del servidor: se relee en vez de suponerla.
      this.datos.reload();
    } catch (e) {
      this.errorCambio.set((e as Error).message);
    } finally {
      this.cambiando.set(false);
    }
  }

  /** Minutos y segundos, que es como se lee la duración de una llamada. */
  duracion(segundos: number): string {
    if (segundos < 60) return `${segundos} s`;
    return `${Math.floor(segundos / 60)} min ${String(segundos % 60).padStart(2, '0')} s`;
  }

  cuando(iso: string | null): string {
    if (!iso) return 'sin fecha';
    return new Date(iso).toLocaleString('es-HN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
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
