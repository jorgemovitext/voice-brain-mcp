import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../auth/auth.service';

/**
 * Perfil de la cuenta con sesión. Su razón de ser es asignar el usuario de
 * acceso: las cuentas creadas cuando el identificador era el teléfono no
 * tienen uno y entran por número. Cambiarlo exige la contraseña actual —
 * es el identificador con el que se entra, y una cookie robada no alcanza.
 */
@Component({
  selector: 'app-profile',
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
})
export class ProfilePage {
  private readonly auth = inject(AuthService);

  readonly cuenta = this.auth.user;
  readonly sinUsuario = computed(() => !this.cuenta()?.username);

  readonly username = signal('');
  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly listo = signal(false);

  readonly puedeGuardar = computed(
    () => this.username().trim().length >= 3 && this.password().length > 0 && !this.busy(),
  );

  asValue(ev: Event): string {
    return (ev.target as HTMLInputElement).value;
  }

  async guardar(ev: Event): Promise<void> {
    ev.preventDefault();
    this.error.set('');
    this.listo.set(false);
    this.busy.set(true);
    try {
      await this.auth.setUsername(this.username().trim().toLowerCase(), this.password());
      this.listo.set(true);
      this.username.set('');
      this.password.set('');
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    } finally {
      this.busy.set(false);
    }
  }

  private mensajeDe(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = (err.error as { message?: string | string[] })?.message;
      if (Array.isArray(msg)) return msg[0] ?? 'No se pudo guardar.';
      if (typeof msg === 'string') return msg;
    }
    return 'No se pudo guardar. Intentá de nuevo.';
  }
}
