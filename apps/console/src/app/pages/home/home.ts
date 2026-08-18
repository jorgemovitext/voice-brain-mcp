import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../../icon';
import { VoiceNebula } from '../../nebula';

/**
 * Inicio estilo asistente: orbe de voz, saludo y acciones rápidas.
 * El input busca contactos (navega a /contacts?q=...).
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon, VoiceNebula],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private readonly router = inject(Router);
  readonly query = signal('');

  search(): void {
    const q = this.query().trim();
    this.router.navigate(['/contacts'], q ? { queryParams: { q } } : undefined);
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
