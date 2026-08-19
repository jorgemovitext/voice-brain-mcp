import { Component, inject, signal } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Icon, IconName } from '../../icon';
import { IntegrationStatus } from '../../models';

/**
 * Integraciones: estado de cada proveedor y los datos para configurarlo.
 * Nunca muestra secretos — el backend solo informa si están presentes.
 * Incluye el alta de un número para empezar a chatear por WhatsApp.
 */
@Component({
  selector: 'app-integrations',
  imports: [RouterLink, Icon, KeyValuePipe],
  templateUrl: './integrations.html',
  styleUrl: './integrations.scss',
})
export class IntegrationsPage {
  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly integrations = httpResource<IntegrationStatus[]>(() => '/api/integrations');

  readonly phone = signal('');
  readonly name = signal('');
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);
  readonly copied = signal<string | null>(null);

  icon(id: IntegrationStatus['id']): IconName {
    return id === 'nlpearl' ? 'phone' : id === 'whatsapp' ? 'chat' : 'mail';
  }

  onPhone(event: Event): void {
    this.phone.set((event.target as HTMLInputElement).value);
  }

  onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(value);
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      // Si el navegador bloquea el portapapeles, el valor igual está visible.
    }
  }

  /** Da de alta el número y abre su conversación. */
  async startChat(): Promise<void> {
    const phone = this.phone().trim();
    if (!phone || this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    try {
      const { contact } = await this.api.createContact(phone, this.name().trim() || undefined);
      this.router.navigate(['/conversations', contact.id]);
    } catch (err: unknown) {
      const message = (err as { error?: { message?: unknown } })?.error?.message;
      this.error.set(
        Array.isArray(message)
          ? 'El teléfono debe ir en formato E.164, por ejemplo +50588887777'
          : 'No se pudo crear la conversación. Revisá el número e intentá de nuevo.',
      );
    } finally {
      this.creating.set(false);
    }
  }
}
