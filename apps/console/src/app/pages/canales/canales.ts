import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { BrainApiService } from '../../brain-api.service';
import { AgenteResumen, Linea } from '../../models';
import { valorDe } from '../../recurso';

/**
 * Canales: la pantalla donde Hive se vuelve multi-cliente.
 *
 * Cada tarjeta es una LÍNEA — el número de WhatsApp de un cliente y el agente
 * que lo atiende. Por ahora el canal es solo WhatsApp (decisión del arranque):
 * la pantalla no ofrece elegir canal porque no hay elección que hacer.
 *
 * El nombre del agente se resuelve acá cruzando con el catálogo: la API de
 * líneas guarda la referencia y la consola jamás muestra un id del proveedor.
 */
@Component({
  selector: 'app-canales',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './canales.html',
  styleUrl: './canales.scss',
})
export class CanalesPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);

  readonly lineas = httpResource<Linea[]>(() => '/api/lineas');
  readonly agentes = httpResource<{ configurado: boolean; agentes: AgenteResumen[] }>(
    () => '/api/agentes',
  );

  readonly creando = signal(false);
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  /** Qué línea tiene el selector de agente abierto. */
  readonly editando = signal<string | null>(null);

  readonly cliente = signal('');
  readonly nombre = signal('');
  readonly numero = signal('');
  readonly agente = signal('');

  readonly listado = computed(() => valorDe(this.lineas) ?? []);
  readonly catalogo = computed(() => valorDe(this.agentes)?.agentes ?? []);

  /** id del agente → nombre, para que la tarjeta hable en humano. */
  readonly nombreDe = computed(() => {
    const porId = new Map(this.catalogo().map((a) => [a.id, a.nombre]));
    return (ref: string) => porId.get(ref) ?? 'Agente retirado';
  });

  /** +50433030235 → +504 3303-0235, que es como se dicta un número acá. */
  telefono(numero: string): string {
    const m = numero.match(/^\+(\d{3})(\d{4})(\d{4})$/);
    return m ? `+${m[1]} ${m[2]}-${m[3]}` : numero;
  }

  escribir(campo: 'cliente' | 'nombre' | 'numero' | 'agente', e: Event): void {
    this[campo].set((e.target as HTMLInputElement | HTMLSelectElement).value);
  }

  readonly puedeCrear = computed(
    () =>
      !!this.cliente().trim() &&
      !!this.nombre().trim() &&
      /^\+?[\d\s-]{8,18}$/.test(this.numero().trim()) &&
      !!this.agente(),
  );

  async crear(): Promise<void> {
    if (!this.puedeCrear() || this.guardando()) return;
    this.guardando.set(true);
    this.error.set(null);
    try {
      const numero = this.numero().trim().replace(/[\s-]/g, '');
      await this.api.crearLinea({
        cliente: this.cliente().trim(),
        nombre: this.nombre().trim(),
        numero: numero.startsWith('+') ? numero : `+${numero}`,
        agente: this.agente(),
      });
      this.cliente.set('');
      this.nombre.set('');
      this.numero.set('');
      this.agente.set('');
      this.creando.set(false);
      this.lineas.reload();
    } catch (e) {
      this.error.set(CanalesPage.motivo(e));
    } finally {
      this.guardando.set(false);
    }
  }

  async pausar(l: Linea): Promise<void> {
    // Botón de emergencia: una línea pausada deja de enrutar YA.
    await this.cambiar(l.id, { estado: l.estado === 'activa' ? 'pausada' : 'activa' });
  }

  async cambiarAgente(l: Linea, e: Event): Promise<void> {
    const agente = (e.target as HTMLSelectElement).value;
    if (!agente || agente === l.agente) {
      this.editando.set(null);
      return;
    }
    await this.cambiar(l.id, { agente });
    this.editando.set(null);
  }

  private async cambiar(id: string, cambios: Parameters<BrainApiService['actualizarLinea']>[1]): Promise<void> {
    this.error.set(null);
    try {
      await this.api.actualizarLinea(id, cambios);
      this.lineas.reload();
    } catch (e) {
      this.error.set(CanalesPage.motivo(e));
    }
  }

  async eliminar(l: Linea): Promise<void> {
    // confirm() nativo alcanza hoy: borrar una línea no borra sus hilos,
    // solo su routing — y el diálogo propio llega con el rediseño Hive.
    if (!confirm(`¿Quitar la línea «${l.nombre}» de ${l.cliente}? El número deja de enrutar a su agente.`)) return;
    this.error.set(null);
    try {
      await this.api.eliminarLinea(l.id);
      this.lineas.reload();
    } catch (e) {
      this.error.set(CanalesPage.motivo(e));
    }
  }

  /** El mensaje del servidor si vino; si no, uno que no asuste. */
  private static motivo(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo guardar. Probá de nuevo.';
  }
}
