import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface SessionUser {
  id: string;
  /** Identificador de acceso. El teléfono solo recibe el OTP. */
  username?: string;
  phone: string;
  name?: string;
}

/**
 * Estado de sesión de la consola. El token vive en una cookie httpOnly que el
 * JS nunca ve: acá solo se guarda el usuario devuelto por /api/auth/me y el
 * navegador adjunta la cookie solo (mismo origen).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly user = signal<SessionUser | null>(null);
  /** true una vez que se consultó /me (evita re-chequear en cada navegación). */
  private checked = false;

  /** Usada por el guard: ¿hay sesión válida? Consulta /me una sola vez. */
  async ensureSession(): Promise<boolean> {
    if (this.user()) return true;
    if (this.checked) return false;
    this.checked = true;
    try {
      this.user.set(await firstValueFrom(this.http.get<SessionUser>('/api/auth/me')));
      return true;
    } catch {
      return false;
    }
  }

  async register(
    username: string,
    password: string,
    phone: string,
    name?: string,
    invitacion?: string,
  ): Promise<void> {
    const { user } = await firstValueFrom(
      this.http.post<{ user: SessionUser }>('/api/auth/register', {
        username,
        password,
        phone,
        name,
        invitacion,
      }),
    );
    this.user.set(user);
  }

  /**
   * ¿Esta instalación ya tiene dueño?
   *
   * La pantalla de alta lo pregunta ANTES de dibujar el formulario: pedir un
   * código que no hace falta —o no pedir el que sí— es la diferencia entre
   * que alguien pueda registrarse o se quede trabado sin saber por qué.
   */
  async requiereInvitacion(): Promise<boolean> {
    const r = await firstValueFrom(
      this.http.get<{ requiereInvitacion: boolean }>('/api/auth/alta'),
    );
    return r.requiereInvitacion;
  }

  async login(username: string, password: string): Promise<{ otpRequired: boolean }> {
    const res = await firstValueFrom(
      this.http.post<{ otpRequired: boolean; user: SessionUser }>('/api/auth/login', { username, password }),
    );
    if (!res.otpRequired) this.user.set(res.user);
    return res;
  }

  async verifyOtp(username: string, code: string): Promise<SessionUser> {
    const res = await firstValueFrom(
      this.http.post<{ user: SessionUser }>('/api/auth/verify-otp', { username, code }),
    );
    this.user.set(res.user);
    this.checked = true;
    return res.user;
  }

  resendOtp(username: string): Promise<{ message: string }> {
    return firstValueFrom(this.http.post<{ message: string }>('/api/auth/resend-otp', { username }));
  }

  /** Fija el usuario de acceso. Exige la contraseña actual aunque haya sesión. */
  async setUsername(username: string, password: string): Promise<SessionUser> {
    const user = await firstValueFrom(
      this.http.post<SessionUser>('/api/auth/username', { username, password }),
    );
    this.user.set(user);
    return user;
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/logout', {})).catch(() => undefined);
    this.user.set(null);
  }

  /** El interceptor la llama ante un 401: fuerza re-chequeo en el próximo guard. */
  sessionExpired(): void {
    this.user.set(null);
    this.checked = false;
  }
}
