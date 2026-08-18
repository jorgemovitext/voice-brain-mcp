import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { ContactListItem } from '../../models';
import { Icon } from '../../icon';
import { channelIconName, channelLabel, formatDate, kycmLabel, sentimentClass, sentimentLabel } from '../../ui';

type Filter = 'all' | 'verified' | 'promise' | 'pending';

/** Paleta pastel para los tiles de avatar (determinista por contacto). */
const TILE_COLORS = ['#ffd9c8', '#cdeffd', '#ffe9a8', '#f3d1ff', '#c8f7d0', '#d7dbff', '#ffd6e7', '#d2f4ee'];

/**
 * Vista Contactos estilo directorio: saludo + búsqueda + chips de filtro
 * y tarjetas con tile de avatar en color pastel. Clic → conversación.
 */
@Component({
  selector: 'app-contacts',
  imports: [RouterLink, Icon],
  templateUrl: './contacts.html',
  styleUrl: './contacts.scss',
})
export class ContactsPage {
  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  /** Query param ?q= (buscador del inicio). El router lo deja undefined si no viene. */
  readonly q = input<string | undefined>(undefined);

  readonly contacts = httpResource<ContactListItem[]>(() => '/api/contacts');
  readonly calling = signal<string | null>(null);
  /** Búsqueda local; arranca con lo que venga del inicio (?q=). */
  readonly search = linkedSignal(() => this.q() ?? '');
  readonly filter = signal<Filter>('all');

  readonly filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: 'Todos' },
    { key: 'verified', label: 'KYCM verificados' },
    { key: 'promise', label: 'Con promesa activa' },
    { key: 'pending', label: 'Sin verificar' },
  ];

  readonly filtered = computed<ContactListItem[]>(() => {
    const query = this.search().trim().toLowerCase();
    const filter = this.filter();
    return (this.contacts.value() ?? [])
      .filter((c) => {
        if (filter === 'verified') return c.kycmStatus === 'verified';
        if (filter === 'promise') return !!c.activePromise;
        if (filter === 'pending') return c.kycmStatus !== 'verified';
        return true;
      })
      .filter(
        (c) =>
          !query ||
          (c.displayName ?? '').toLowerCase().includes(query) ||
          c.phones.some((p) => p.includes(query)),
      );
  });

  readonly channelIconName = channelIconName;
  readonly channelLabel = channelLabel;
  readonly sentimentClass = sentimentClass;
  readonly sentimentLabel = sentimentLabel;
  readonly kycmLabel = kycmLabel;
  readonly formatDate = formatDate;

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  initials(c: ContactListItem): string {
    return (c.displayName ?? '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  /** Color pastel estable derivado del id del contacto. */
  tileColor(c: ContactListItem): string {
    let hash = 0;
    for (const ch of c.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return TILE_COLORS[hash % TILE_COLORS.length];
  }

  subtitle(c: ContactListItem): string {
    if (c.activePromise) {
      const due = c.activePromise.dueDate ? ` · vence ${c.activePromise.dueDate}` : '';
      return `Promesa ${c.activePromise.amount}${due}`;
    }
    return this.kycmLabel(c.kycmStatus);
  }

  async call(event: MouseEvent, contactId: string): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    this.calling.set(contactId);
    try {
      await this.api.triggerCall(contactId);
      // La llamada mock cierra su ciclo en ~2s; abrimos la conversación para verla en vivo.
      this.router.navigate(['/contacts', contactId]);
    } finally {
      setTimeout(() => this.calling.set(null), 1500);
    }
  }
}
