import { Component, effect, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { ContactListItem } from '../../models';

/**
 * Índice del módulo Conversaciones (/conversations): abre el hilo con la
 * actividad más reciente. Si no hay ninguno, invita a correr la demo.
 */
@Component({
  selector: 'app-conversations-index',
  imports: [RouterLink],
  template: `
    @if (contacts.isLoading()) {
      <div class="state"><div class="spinner"></div>Cargando conversaciones…</div>
    } @else if (contacts.error()) {
      <div class="state state--error">
        No se pudieron cargar las conversaciones. ¿Está corriendo la API en el puerto 3000?
        <div><button class="btn btn--primary" (click)="contacts.reload()">Reintentar</button></div>
      </div>
    } @else {
      <div class="state">
        Todavía no hay conversaciones.
        <p>Corré el <a routerLink="/demo">flujo demo</a> para sembrar datos.</p>
      </div>
    }
  `,
})
export class ConversationsIndexPage {
  private readonly router = inject(Router);

  readonly contacts = httpResource<ContactListItem[]>(() => '/api/contacts');

  constructor() {
    effect(() => {
      const list = this.contacts.value();
      if (!list?.length) return;
      // El hilo con la interacción más reciente primero.
      const [first] = [...list].sort((a, b) =>
        (b.lastInteraction?.occurredAt ?? '').localeCompare(a.lastInteraction?.occurredAt ?? ''),
      );
      void this.router.navigate(['/conversations', first.id], { replaceUrl: true });
    });
  }
}
