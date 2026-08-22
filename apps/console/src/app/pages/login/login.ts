import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../auth/auth.service';

type Modo = 'login' | 'register';
type Paso = 'credenciales' | 'otp';

/**
 * Acceso a la consola: iniciar sesión o crear cuenta, siempre con el código
 * OTP por WhatsApp como segundo paso. Sin sesión, toda ruta cae acá.
 */
@Component({
  selector: 'app-login',
  template: `
    <div class="auth">
      <div class="auth__card card">
        <div class="auth__brand">
          <span class="auth__orb"></span>
          <div>
            <h1>Movitext <span>Brain</span></h1>
            <p>Consola de atención omnicanal</p>
          </div>
        </div>

        @if (paso() === 'credenciales') {
          <div class="auth__tabs">
            <button class="auth__tab" [class.auth__tab--active]="modo() === 'login'" (click)="cambiarModo('login')">
              Iniciar sesión
            </button>
            <button class="auth__tab" [class.auth__tab--active]="modo() === 'register'" (click)="cambiarModo('register')">
              Crear cuenta
            </button>
          </div>

          <form (submit)="enviarCredenciales($event)">
            @if (modo() === 'register') {
              <label class="auth__field">
                <span>Nombre</span>
                <input type="text" autocomplete="name" [value]="name()" (input)="name.set(asValue($event))" placeholder="Tu nombre" />
              </label>
            }
            <label class="auth__field">
              <span>Teléfono (WhatsApp)</span>
              <input type="tel" autocomplete="tel" [value]="phone()" (input)="phone.set(asValue($event))" placeholder="+50499998888" required />
            </label>
            <label class="auth__field">
              <span>Contraseña</span>
              <input type="password" [attr.autocomplete]="modo() === 'login' ? 'current-password' : 'new-password'"
                     [value]="password()" (input)="password.set(asValue($event))"
                     placeholder="Mínimo 8 caracteres, letras y números" required />
            </label>

            @if (error()) {
              <p class="auth__error">{{ error() }}</p>
            }

            <button class="btn btn--primary auth__submit" type="submit" [disabled]="busy()">
              @if (busy()) { <span class="spinner spinner--sm"></span> }
              {{ modo() === 'login' ? 'Continuar' : 'Crear cuenta' }}
            </button>
          </form>
        } @else {
          <div class="auth__otp">
            <h2>Revisá tu WhatsApp</h2>
            <p>Te enviamos un código de 6 dígitos a <strong>{{ phone() }}</strong>. Vence en 5 minutos.</p>
            <form (submit)="enviarOtp($event)">
              <input class="auth__code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
                     [value]="code()" (input)="code.set(soloDigitos($event))" placeholder="••••••" />
              @if (error()) {
                <p class="auth__error">{{ error() }}</p>
              }
              <button class="btn btn--primary auth__submit" type="submit" [disabled]="busy() || code().length !== 6">
                @if (busy()) { <span class="spinner spinner--sm"></span> }
                Verificar código
              </button>
            </form>
            <div class="auth__links">
              <button class="auth__link" (click)="reenviar()" [disabled]="busy() || reenviado()">
                {{ reenviado() ? 'Código reenviado' : 'Reenviar código' }}
              </button>
              <button class="auth__link" (click)="volver()">Usar otro número</button>
            </div>
          </div>
        }
      </div>
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
  readonly phone = signal('');
  readonly password = signal('');
  readonly code = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly reenviado = signal(false);

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
      if (this.modo() === 'register') {
        await this.auth.register(this.phone().trim(), this.password(), this.name().trim() || undefined);
      } else {
        await this.auth.login(this.phone().trim(), this.password());
      }
      this.paso.set('otp');
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
      await this.auth.verifyOtp(this.phone().trim(), this.code());
      await this.router.navigate(['/home']);
    } catch (err) {
      this.error.set(this.mensajeDe(err));
    } finally {
      this.busy.set(false);
    }
  }

  async reenviar(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.resendOtp(this.phone().trim());
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
