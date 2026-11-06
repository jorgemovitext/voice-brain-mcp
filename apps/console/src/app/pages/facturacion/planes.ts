import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Plan } from '../../models';
import { valorDe } from '../../recurso';

interface Respuesta {
  actual: string;
  enLista: boolean;
  planes: Plan[];
  nombreFuncion: Record<string, string>;
  empresa?: string;
}

/**
 * Los planes, y en cuál está la empresa.
 *
 * Lo que se cobra son DOS cosas y la pantalla las separa a propósito: el plan
 * es el agente trabajando, por mes; los mensajes se cobran por unidad y según
 * el país. Mezclarlas en un precio único suena más simple y es la forma más
 * rápida de que el cliente se sienta engañado cuando llegue la factura.
 *
 * Cambiar de plan no pasa por una pasarela porque todavía no hay: se aplica y
 * el cobro va por factura. La pantalla lo dice con esas palabras — un
 * checkout de mentira que diga «pago aprobado» sin cobrar nada es peor que no
 * tenerlo, porque el cliente cree que pagó.
 */
@Component({
  selector: 'app-planes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './planes.html',
  styleUrl: './planes.scss',
})
export class PlanesPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);

  readonly datos = httpResource<Respuesta>(() => '/api/facturacion/planes');

  readonly cambiando = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly listo = signal<string | null>(null);
  /** El plan que se está por confirmar: cambiar cuesta plata, se pregunta. */
  readonly confirmando = signal<Plan | null>(null);

  readonly planes = computed(() => valorDe(this.datos)?.planes ?? []);
  readonly actual = computed(() => valorDe(this.datos)?.actual ?? 'prueba');
  readonly empresa = computed(() => valorDe(this.datos)?.empresa);
  readonly fueraDeLista = computed(() => valorDe(this.datos)?.enLista === false);

  /** Todas las funciones que existen, en el orden del plan más completo. */
  readonly funciones = computed(() => {
    const nombres = valorDe(this.datos)?.nombreFuncion ?? {};
    const vistas: string[] = [];
    for (const p of this.planes()) for (const f of p.funciones) if (!vistas.includes(f)) vistas.push(f);
    return vistas.map((id) => ({ id, nombre: nombres[id] ?? id }));
  });

  dolares(micros: number): string {
    return `US$ ${(micros / 1_000_000).toFixed(0)}`;
  }

  /** «sin tope» en vez de «null», que no significa nada para quien lee. */
  tope(valor: number | null): string {
    return valor === null ? 'Sin tope' : String(valor);
  }

  tiene(plan: Plan, funcion: string): boolean {
    return plan.funciones.includes(funcion);
  }

  esActual(plan: Plan): boolean {
    return plan.id === this.actual();
  }

  /** ¿Este plan es un paso arriba o uno abajo del actual? */
  direccion(plan: Plan): 'sube' | 'baja' | 'igual' {
    const orden = this.planes().map((p) => p.id);
    const aqui = orden.indexOf(this.actual());
    const alla = orden.indexOf(plan.id);
    if (aqui < 0 || alla < 0 || aqui === alla) return 'igual';
    return alla > aqui ? 'sube' : 'baja';
  }

  async cambiar(plan: Plan): Promise<void> {
    if (this.cambiando()) return;
    this.cambiando.set(plan.id);
    this.error.set(null);
    this.listo.set(null);
    try {
      await this.api.cambiarPlan(plan.id);
      this.listo.set(plan.nombre);
      this.confirmando.set(null);
      this.datos.reload();
    } catch (e) {
      const err = e as { error?: { message?: string }; message?: string };
      this.error.set(err?.error?.message ?? err?.message ?? 'No se pudo cambiar el plan.');
    } finally {
      this.cambiando.set(null);
    }
  }
}
