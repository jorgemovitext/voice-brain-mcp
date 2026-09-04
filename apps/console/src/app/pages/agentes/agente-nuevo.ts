import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';

/**
 * Por dónde empezar un agente.
 *
 * Antes se empezaba escribiendo un nombre en la lista y el operador caía en un
 * editor vacío: se le pedía lo único que da igual y quedaba todo el trabajo
 * real —qué dice, qué puede hacer, por qué fases pasa— por delante y sin
 * ayuda.
 *
 * El camino con flujo va PRIMERO porque es el que deja un agente armado; el
 * formulario queda para quien ya sabe exactamente lo que quiere escribir.
 */
@Component({
  selector: 'app-agente-nuevo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './agente-nuevo.html',
  styleUrl: './agente-nuevo.scss',
})
export class AgenteNuevoPage {
  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly nombre = signal('');
  readonly creando = signal(false);
  readonly error = signal<string | null>(null);

  escribirNombre(e: Event): void {
    this.nombre.set((e.target as HTMLInputElement).value);
  }

  /**
   * El camino corto: nombre y al editor.
   *
   * Nace sin herramientas y con instrucciones mínimas a propósito: quien elige
   * este camino ya sabe qué va a escribir, y un prompt de ejemplo puesto por
   * nosotros terminaría medio borrado dentro del suyo.
   */
  async crear(): Promise<void> {
    const nombre = this.nombre().trim();
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
}
