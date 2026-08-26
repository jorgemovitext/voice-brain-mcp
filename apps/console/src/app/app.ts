import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './auth/auth.service';
import { Sonido } from './sonido';

/** Layout raíz: header con marca + navegación por pills. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly sonido = inject(Sonido);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** En la pantalla de acceso el rail no se muestra. */
  readonly enLogin = computed(() => this.url().startsWith('/login'));

  /** Cuentas anteriores al login por usuario: el rail lo señala. */
  readonly sinUsuario = computed(() => !!this.auth.user() && !this.auth.user()?.username);

  /** Iniciales del operador con sesión (fallback genérico). */
  readonly iniciales = computed(() => {
    const sesion = this.auth.user();
    const name = sesion?.name?.trim() || sesion?.username?.trim();
    if (!name) return '·';
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('');
  });

  async cerrarSesion(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
