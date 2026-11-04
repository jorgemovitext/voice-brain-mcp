import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { AuthService } from '../../auth/auth.service';
import { BrainApiService } from '../../brain-api.service';
import { valorDe } from '../../recurso';

interface Miembro {
  id: string;
  username?: string;
  name?: string;
  phone: string;
  creada: string;
}

interface InvitacionVista {
  id: string;
  phone?: string;
  nota?: string;
  creada: string;
  expira: string;
  usada?: string;
  vigente: boolean;
}

/**
 * Quién puede entrar a la consola, y cómo entra alguien nuevo.
 *
 * Existe porque hasta hace poco la respuesta era «cualquiera»: el registro
 * era público y entregaba sesión al instante. Ahora el alta va por
 * invitación, y una invitación sin una pantalla donde crearla es una puerta
 * cerrada sin llave para nadie.
 */
@Component({
  selector: 'app-equipo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './equipo.html',
  styleUrl: './equipo.scss',
})
export class EquipoPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);
  private readonly auth = inject(AuthService);

  readonly miembros = httpResource<Miembro[]>(() => '/api/auth/equipo');
  readonly invitaciones = httpResource<InvitacionVista[]>(() => '/api/auth/invitaciones');

  readonly error = signal<string | null>(null);
  readonly generando = signal(false);
  readonly nota = signal('');
  readonly telefono = signal('');

  /**
   * El código recién creado. Se muestra UNA vez y después se pierde: del
   * lado del servidor solo queda su hash, así que no hay forma de volver a
   * leerlo — y eso es a propósito.
   */
  readonly codigoNuevo = signal<string | null>(null);
  readonly copiado = signal(false);

  readonly lista = computed(() => valorDe(this.miembros) ?? []);
  readonly pendientes = computed(() => (valorDe(this.invitaciones) ?? []).filter((i) => i.vigente));

  /** Quién sos vos: tu fila no ofrece el botón de baja. */
  readonly yo = computed(() => this.auth.user()?.username ?? null);

  escribir(campo: 'nota' | 'telefono', e: Event): void {
    this[campo].set((e.target as HTMLInputElement).value);
  }

  async invitar(): Promise<void> {
    if (this.generando()) return;
    this.generando.set(true);
    this.error.set(null);
    this.copiado.set(false);
    try {
      const { codigo } = await this.api.crearInvitacion({
        phone: this.telefono().trim() || undefined,
        nota: this.nota().trim() || undefined,
      });
      this.codigoNuevo.set(codigo);
      this.nota.set('');
      this.telefono.set('');
      this.invitaciones.reload();
    } catch (e) {
      this.error.set(EquipoPage.motivo(e));
    } finally {
      this.generando.set(false);
    }
  }

  async copiar(): Promise<void> {
    const codigo = this.codigoNuevo();
    if (!codigo) return;
    try {
      await navigator.clipboard.writeText(codigo);
      this.copiado.set(true);
    } catch {
      // Sin permiso de portapapeles el código igual está en pantalla.
      this.copiado.set(false);
    }
  }

  async revocar(i: InvitacionVista): Promise<void> {
    this.error.set(null);
    try {
      await this.api.revocarInvitacion(i.id);
      this.invitaciones.reload();
    } catch (e) {
      this.error.set(EquipoPage.motivo(e));
    }
  }

  async quitar(m: Miembro): Promise<void> {
    const quien = m.name || m.username || 'esa cuenta';
    if (!confirm(`¿Quitar a ${quien} de la consola? Pierde el acceso de inmediato.`)) return;
    this.error.set(null);
    try {
      await this.api.quitarDelEquipo(m.id);
      this.miembros.reload();
    } catch (e) {
      this.error.set(EquipoPage.motivo(e));
    }
  }

  cuando(iso: string): string {
    return new Date(iso).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Cuánto le queda de vida a una invitación, en palabras. */
  vence(iso: string): string {
    const horas = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
    if (horas <= 0) return 'vencida';
    if (horas < 24) return `vence en ${horas} h`;
    return `vence en ${Math.round(horas / 24)} días`;
  }

  iniciales(m: Miembro): string {
    const n = (m.name || m.username || '·').trim();
    return n
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('');
  }

  private static motivo(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo completar. Probá de nuevo.';
  }
}
