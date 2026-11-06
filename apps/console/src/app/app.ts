import { Component, DestroyRef, computed, effect, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './auth/auth.service';
import { BrainApiService } from './brain-api.service';
import { Sonido } from './sonido';

/** Cada cuánto se le pregunta al servidor si falta alguna llamada. */
const MINUTOS_ENTRE_RECONCILIACIONES = 5;

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
  private readonly api = inject(BrainApiService);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** En la pantalla de acceso el rail no se muestra. */
  readonly enLogin = computed(() => this.url().startsWith('/login'));

  /** El nombre para la cabecera: el propio, con el usuario como respaldo. */
  readonly quienSoy = computed(() => {
    const sesion = this.auth.user();
    return sesion?.name?.trim() || sesion?.username?.trim() || 'Operador';
  });

  /**
   * El rol, para la barra. Decía «Operador» cableado para todo el mundo —
   * incluso para el administrador de la cuenta, que es el único que puede
   * configurar algo.
   */
  readonly miRol = computed(() => (this.auth.user()?.rol === 'admin' ? 'Administrador' : 'Usuario'));

  /** Solo el administrador ve lo de plata: el consumo y el plan son del dueño. */
  readonly veFacturacion = computed(() => this.auth.puede('facturacion:ver'));

  /** Cuentas anteriores al login por usuario: el rail lo señala. */
  readonly sinUsuario = computed(() => !!this.auth.user() && !this.auth.user()?.username);

  /** Iniciales del operador con sesión (fallback genérico). */
  /**
   * Quién atiende, en la cabecera de TODA la app.
   *
   * Va en el armazón y no en una pantalla porque con varias líneas
   * conviviendo es contexto permanente: el operador tiene que saber, mire lo
   * que mire, de quién es lo que está viendo.
   */
  private readonly activoRecurso = httpResource<{ id: string; nombre: string | null }>(() =>
    this.auth.user() ? '/api/agentes/activo' : undefined,
  );

  readonly agenteActivo = computed(() => {
    const r = this.activoRecurso.value();
    return r?.nombre ?? null;
  });

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

  /**
   * Red de seguridad de las llamadas.
   *
   * El webhook de post-llamada es de un solo intento: si se cae mientras hay
   * un despliegue en curso, esa llamada no aparece nunca y nadie se entera.
   * Acá se le pregunta al servidor cada tanto, desde cualquier pantalla y no
   * solo desde la bandeja, si quedó alguna afuera.
   *
   * El freno de verdad es del servidor —una revisión cada cuarto de hora como
   * mucho—; esto solo le da la oportunidad de ejecutarlo. Sin sesión no se
   * pregunta nada.
   */
  constructor() {
    const destroy = inject(DestroyRef);
    const preguntar = () => {
      if (!this.auth.user()) return;
      void this.api.reconciliarLlamadas().catch(() => undefined);
    };

    // La primera, al entrar con sesión: es cuando más se nota el hueco. Va sin
    // mirar si la pestaña está al frente — la consola se abre a menudo en una
    // pestaña de fondo, y con ese filtro la primera revisión no llegaba nunca.
    effect(() => {
      if (this.auth.user()) preguntar();
    });

    /*
     * El latido sí se calla en segundo plano: una pestaña olvidada no tiene
     * por qué seguir preguntando. A cambio, se pregunta al VOLVER — que es
     * justo cuando alguien quiere ver lo que pasó mientras no miraba.
     */
    const alVolver = () => {
      if (document.visibilityState === 'visible') preguntar();
    };
    document.addEventListener('visibilitychange', alVolver);

    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') preguntar();
    }, MINUTOS_ENTRE_RECONCILIACIONES * 60_000);

    destroy.onDestroy(() => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', alVolver);
    });
  }

  async cerrarSesion(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
