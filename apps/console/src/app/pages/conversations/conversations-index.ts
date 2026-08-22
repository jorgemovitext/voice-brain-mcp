import { Component, DestroyRef, effect, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { ContactListItem } from '../../models';

/**
 * Índice del módulo Conversaciones (/conversations): abre el hilo con la
 * actividad más reciente.
 *
 * Mientras no hay ninguno se queda esperando: sincroniza con NL Pearl y
 * relee la lista, así una conversación que entra por SMS/WhatsApp aparece
 * sola (sin esto, la pantalla vacía nunca disparaba el sync y había que
 * recargar a mano para ver el primer mensaje).
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
        <div class="spinner"></div>
        Esperando conversaciones…
        <p>
          Escribí al número de la Pearl y el hilo aparece acá solo. También podés
          dar de alta un número en <a routerLink="/integrations">Integraciones</a>.
        </p>
      </div>
    }
  `,
})
export class ConversationsIndexPage {
  private readonly router = inject(Router);
  private readonly api = inject(BrainApiService);
  private readonly destroyRef = inject(DestroyRef);

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

    this.esperarConversaciones();
  }

  /**
   * Sondeo mientras la bandeja está vacía. El sync va en modo `soft`: el
   * backend lo limita a uno cada ~30 s, así que pedirlo seguido no multiplica
   * las llamadas a NL Pearl.
   */
  private esperarConversaciones(): void {
    void this.api.syncNlpearl().catch(() => undefined);

    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void this.api.syncNlpearl().catch(() => undefined);
      this.contacts.reload();
    }, 4000);

    this.destroyRef.onDestroy(() => clearInterval(tick));
  }
}
