import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AgenteResumen } from '../../models';
import { valorDe } from '../../recurso';

/**
 * Los agentes que atienden: crear, configurar y probar sin salir de acá.
 *
 * Vive en la consola y no en el panel del proveedor por dos razones: el equipo
 * que escribe lo que dice el agente no debería necesitar credenciales de
 * ElevenLabs, y lo que hace el agente —abrir tickets, avisar a la cuadrilla—
 * se define de este lado.
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
    return a.herramientas.filter((h) => h !== 'end_call' && h !== 'language_detection').length;
  }
}
