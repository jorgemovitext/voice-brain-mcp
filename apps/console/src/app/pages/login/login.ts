import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../auth/auth.service';

type Modo = 'login' | 'register';
type Paso = 'credenciales' | 'otp';

/**
 * Acceso a la consola: usuario y contraseña, tanto para entrar como para dar
 * de alta la cuenta. El código por WhatsApp dejó de ser un paso obligatorio y
 * quedó como la vía para recuperar el acceso. Sin sesión, toda ruta cae acá.
 */
@Component({
  selector: 'app-login',
  template: `
    <div class="auth">
      <!-- Panel izquierdo: qué es esto y por qué se puede confiar. Un login a
           secas no dice en qué está entrando uno; en una consola con datos de
           ciudadanos, eso importa. -->
      <aside class="marca">
        <div class="marca__top">
          <span class="marca__orb"></span>
          <h1>Hive</h1>
        </div>

        <div class="marca__centro">
          <p class="marca__claim">Tus agentes atendiendo WhatsApp.</p>
          <p class="marca__bajada">
            Contestan en segundos, agendan, registran y pasan a una persona cuando hace falta.
          </p>
        </div>

        <!-- Trazo, no emoji: el emoji cambia de forma en cada sistema y a
             este tamaño se lee como un adorno pegado, no como parte del
             diseño. -->
        <ul class="marca__sellos">
          <li>
            <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></i>
            Sesión cifrada y firmada
          </li>
          <li>
            <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3.5 7.5 8.5 6 8.5-6"/></svg></i>
            El alta es solo por invitación
          </li>
          <li>
            <i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></i>
            La sesión se cierra sola por inactividad
          </li>
        </ul>
        <p class="marca__pie">Movitext · Centroamérica</p>
      </aside>

      <!-- Panel derecho: el formulario y nada más. -->
      <main class="forma">
        <div class="forma__caja">
          @if (paso() === 'credenciales') {
            <header class="forma__cabeza">
              <h2>{{ modo() === 'login' ? 'Entrar a la consola' : 'Crear tu cuenta' }}</h2>
              <p>
                @if (modo() === 'login') {
                  ¿No tenés cuenta?
                  <button class="enlace" type="button" (click)="cambiarModo('register')">Creala con tu invitación</button>
                } @else {
                  ¿Ya tenés una?
                  <button class="enlace" type="button" (click)="cambiarModo('login')">Iniciá sesión</button>
                }
              </p>
            </header>

            <form (submit)="enviarCredenciales($event)" novalidate>
              @if (modo() === 'register') {
                <label class="campo">
                  <span class="campo__rotulo">Tu nombre</span>
                  <input class="campo__input" type="text" autocomplete="name" placeholder="Jorge Murcia"
                         [value]="name()" (input)="name.set(asValue($event))" />
                </label>
              }

              <!-- El teléfono sigue sirviendo como identificador para las
                   cuentas viejas, pero no se anuncia: pedir "usuario o
                   teléfono" hacía dudar de cuál poner en el caso normal. -->
              <label class="campo">
                <span class="campo__rotulo">Usuario</span>
                <input class="campo__input" type="text" autocomplete="username" spellcheck="false"
                       autocapitalize="none" placeholder="tu.usuario"
                       [value]="username()" (input)="username.set(asValue($event))" />
              </label>

              @if (modo() === 'register') {
                <label class="campo">
                  <span class="campo__rotulo">Teléfono (WhatsApp)</span>
                  <input class="campo__input" type="tel" autocomplete="tel" placeholder="+504 9999-8888"
                         [value]="phone()" (input)="phone.set(asValue($event))" />
                  <span class="campo__ayuda">Solo para recuperar el acceso. No es tu usuario.</span>
                </label>

                @if (conInvitacion()) {
                  <label class="campo">
                    <span class="campo__rotulo">Código de invitación</span>
                    <input class="campo__input campo__input--codigo" placeholder="ABCD-EFGH-JKLM"
                           autocapitalize="characters" spellcheck="false"
                           [value]="invitacion()" (input)="invitacion.set(asValue($event))" />
                    <span class="campo__ayuda">Te lo pasa alguien del equipo desde Equipo → Invitar.</span>
                  </label>
                } @else {
                  <p class="primera">
                    <strong>Primera cuenta de la consola.</strong>
                    Se crea sin invitación, y desde ella se invita al resto.
                  </p>
                }
              }

              <label class="campo">
                <span class="campo__rotulo">
                  Contraseña
                  @if (modo() === 'login') {
                    <button class="campo__enlace" type="button" (click)="entrarConCodigo()"
                            [disabled]="busy() || !username().trim()">No la recuerdo</button>
                  }
                </span>
                <span class="campo__conBoton">
                  <input class="campo__input" [type]="verClave() ? 'text' : 'password'"
                         [attr.autocomplete]="modo() === 'login' ? 'current-password' : 'new-password'"
                         [placeholder]="modo() === 'login' ? 'Tu contraseña' : 'Mínimo 8, con letras y números'"
                         [value]="password()" (input)="password.set(asValue($event))"
                         (keyup)="mirarMayusculas($event)" />
                  <button class="campo__ojo" type="button" (click)="verClave.set(!verClave())"
                          [attr.aria-label]="verClave() ? 'Ocultar la contraseña' : 'Ver la contraseña'">
                    {{ verClave() ? '◡' : '◉' }}
                  </button>
                </span>

                <!-- Bloq Mayús es la causa más común de «la contraseña no me
                     funciona» y el navegador no avisa dentro del campo. -->
                @if (mayusculas()) {
                  <span class="campo__ayuda campo__ayuda--ojo">⚠ Tenés Bloq Mayús activado.</span>
                }

                @if (modo() === 'register' && password()) {
                  <span class="fuerza">
                    <span class="fuerza__barra">
                      <i [style.width.%]="fuerza().pct" [class]="'fuerza__relleno fuerza__relleno--' + fuerza().nivel"></i>
                    </span>
                    <em>{{ fuerza().texto }}</em>
                  </span>
                }
              </label>

              @if (error()) {
                <p class="alerta" role="alert">{{ error() }}</p>
              }

              <button class="enviar" type="submit" [disabled]="busy()">
                @if (busy()) { <span class="spinner spinner--sm"></span> }
                {{ busy() ? 'Verificando…' : modo() === 'login' ? 'Entrar' : 'Crear cuenta' }}
              </button>
            </form>
          } @else {
            <!-- Paso del código -->
            <header class="forma__cabeza">
              <h2>Revisá tu WhatsApp</h2>
              <p>Te mandamos un código de 6 dígitos a <strong>{{ destino() }}</strong>. Vence en 5 minutos.</p>
            </header>

            <form (submit)="enviarOtp($event)" novalidate>
              <input class="codigo" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
                     placeholder="000000" [value]="code()" (input)="code.set(soloDigitos($event))" />

              @if (error()) {
                <p class="alerta" role="alert">{{ error() }}</p>
              }

              <button class="enviar" type="submit" [disabled]="busy() || code().length !== 6">
                @if (busy()) { <span class="spinner spinner--sm"></span> }
                Verificar código
              </button>
            </form>

            <div class="forma__pie">
              <button class="enlace" type="button" (click)="reenviar()" [disabled]="busy() || reenviado()">
                {{ reenviado() ? 'Código reenviado' : 'Reenviar código' }}
              </button>
              <button class="enlace" type="button" (click)="volver()">Usar otro usuario</button>
            </div>
          }
        </div>
      </main>
    </div>
  `,
  styleUrl: './login.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly modo = signal<Modo>('login');
  readonly paso = signal<Paso>('credenciales');
  readonly name = signal('');
  readonly username = signal('');
  readonly phone = signal('');
  readonly invitacion = signal('');
  /** Si ya hay alguien registrado, el alta exige código. */
  readonly conInvitacion = signal(true);

  constructor() {
    // Por defecto SÍ se pide: si la consulta falla, el formulario pide el
    // código de más y no de menos.
    void this.auth
      .requiereInvitacion()
      .then((hace) => this.conInvitacion.set(hace))
      .catch(() => this.conInvitacion.set(true));
  }
  readonly password = signal('');
  readonly code = signal('');
  readonly verClave = signal(false);
  readonly mayusculas = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly reenviado = signal(false);

  /** Al registrarse se conoce el número; al iniciar sesión no se revela. */
  readonly destino = computed(() => this.phone().trim() || 'tu WhatsApp registrado');

  /** Bloq Mayús: la causa más común de «la contraseña no me funciona». */
  mirarMayusculas(ev: KeyboardEvent): void {
    if (typeof ev.getModifierState === 'function') {
      this.mayusculas.set(ev.getModifierState('CapsLock'));
    }
  }

  /**
   * Fuerza de la contraseña, al crear la cuenta.
   *
   * Mide longitud y variedad, no reglas de composición: obligar a un símbolo
   * produce «Password1!» en todas las cuentas, que es peor que una frase
   * larga. Es una guía, no una barrera — el mínimo real lo valida el servidor.
   */
  readonly fuerza = computed(() => {
    const p = this.password();
    let puntos = 0;
    if (p.length >= 8) puntos++;
    if (p.length >= 14) puntos++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) puntos++;
    if (/\d/.test(p)) puntos++;
    if (/[^\w\s]/.test(p)) puntos++;

    if (puntos <= 2) return { nivel: 'floja', pct: 33, texto: 'Floja: hacela más larga' };
    if (puntos === 3) return { nivel: 'media', pct: 66, texto: 'Aceptable' };
    return { nivel: 'buena', pct: 100, texto: 'Buena' };
  });

  asValue(ev: Event): string {
    return (ev.target as HTMLInputElement).value;
  }

  soloDigitos(ev: Event): string {
    return (ev.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
  }

  cambiarModo(modo: Modo): void {
    this.modo.set(modo);
    this.error.set('');
  }

  volver(): void {
    this.paso.set('credenciales');
    this.code.set('');
    this.error.set('');
    this.reenviado.set(false);
  }

  async enviarCredenciales(ev: Event): Promise<void> {
    ev.preventDefault();
    this.error.set('');
    this.busy.set(true);
    try {
      const usuario = this.username().trim().toLowerCase();
      if (this.modo() === 'register') {
        await this.auth.register(
          usuario,
          this.password(),
          this.phone().trim(),
          this.name().trim() || undefined,
          this.invitacion().trim() || undefined,
        );
        await this.router.navigate(['/home']);
        return;
      }

      // Entrar es usuario y contraseña. El código quedó como la vía para
      // recuperar el acceso, no como un paso obligatorio de cada entrada.
      const { otpRequired } = await this.auth.login(usuario, this.password());
      if (otpRequired) {
        this.paso.set('otp');
        return;
      }
      await this.router.navigate(['/home']);
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    } finally {
      this.busy.set(false);
    }
  }

  async enviarOtp(ev: Event): Promise<void> {
    ev.preventDefault();
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.verifyOtp(this.username().trim().toLowerCase(), this.code());
      await this.router.navigate(['/home']);
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Pide un código y salta al paso de verificación: sin contraseña. */
  async entrarConCodigo(): Promise<void> {
    const usuario = this.username().trim().toLowerCase();
    if (!usuario || this.busy()) return;
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.resendOtp(usuario);
      this.paso.set('otp');
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    } finally {
      this.busy.set(false);
    }
  }

  async reenviar(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.resendOtp(this.username().trim().toLowerCase());
      this.reenviado.set(true);
      setTimeout(() => this.reenviado.set(false), 60_000);
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    }
  }

  private mensajeDe(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = (err.error as { message?: string | string[] })?.message;
      if (Array.isArray(msg)) return msg[0] ?? 'No se pudo completar la operación.';
      if (typeof msg === 'string') return msg;
    }
    return 'No se pudo completar la operación. Intentá de nuevo.';
  }
}
