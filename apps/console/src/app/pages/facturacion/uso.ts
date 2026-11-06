import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Categoria, Tarifas, Uso, UsoPeriodo } from '../../models';
import { valorDe } from '../../recurso';

const NOMBRE_CATEGORIA: Record<Categoria, string> = {
  servicio: 'Respuesta',
  utilidad: 'Aviso útil',
  autenticacion: 'Código',
  marketing: 'Promoción',
};

const NOMBRE_MOTIVO: Record<string, string> = {
  respuesta: 'El agente contestó',
  seguimiento: 'Seguimiento automático',
  operador: 'Lo escribió una persona',
  plantilla: 'Apertura con plantilla',
  traspaso: 'Cambio de agente',
};

/**
 * Uso y facturación: qué se mandó, a dónde, y cuánto va a costar.
 *
 * La pantalla está armada alrededor de UNA pregunta —«¿cuánto voy a pagar
 * este mes?»— y recién después abre el detalle. Al revés, con la tabla
 * primero, el cliente tiene que sumar de cabeza para enterarse de lo único
 * que vino a ver.
 *
 * Todas las cuentas vienen del servidor. La tentación es multiplicar
 * mensajes por un precio promedio en el navegador, y eso daría un número
 * que no es el de la factura: el precio depende del país y de la categoría
 * de cada mensaje, y cada fila guarda el precio que tenía cuando salió.
 */
@Component({
  selector: 'app-uso',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './uso.html',
  styleUrl: './uso.scss',
})
export class UsoPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);

  readonly datos = httpResource<Uso>(() => '/api/facturacion/uso');

  /** El período que se está mirando. Vacío = el mes en curso. */
  readonly periodo = signal<string>('');
  readonly historico = httpResource<UsoPeriodo>(() =>
    this.periodo() ? `/api/facturacion/uso/${this.periodo()}` : undefined,
  );

  /*
   * La tarifa por país. Va aparte del uso porque no cambia con el mes: es
   * la lista de precios, y el cliente tiene derecho a verla ANTES de que le
   * llegue la factura y no solo después.
   */
  readonly tarifas = httpResource<Tarifas>(() => '/api/facturacion/tarifas');
  readonly verTarifas = signal(false);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  readonly editandoTope = signal(false);
  readonly topeBorrador = signal<string>('');

  readonly estado = computed(() => valorDe(this.datos)?.estado);
  readonly detalle = computed(() => valorDe(this.historico) ?? valorDe(this.datos)?.detalle);
  readonly periodos = computed(() => valorDe(this.datos)?.periodos ?? []);
  readonly ultimos = computed(() => valorDe(this.datos)?.ultimos ?? []);
  readonly enElMesActual = computed(() => !this.periodo());

  /** Microdólares → «US$ 12.34». Es lo que se imprime en la factura. */
  dolares(micros: number | undefined): string {
    return `US$ ${((micros ?? 0) / 1_000_000).toFixed(2)}`;
  }

  /** Para precios por mensaje, que viven en la cuarta decimal. */
  precioUnitario(micros: number, mensajes: number): string {
    if (!mensajes) return '—';
    return `US$ ${(micros / mensajes / 1_000_000).toFixed(4)}`;
  }

  categoria(c: Categoria): string {
    return NOMBRE_CATEGORIA[c] ?? c;
  }

  motivo(m: string): string {
    return NOMBRE_MOTIVO[m] ?? m;
  }

  /** «2026-11» → «noviembre de 2026». */
  mes(periodo: string): string {
    const [anio, mes] = periodo.split('-');
    const nombres = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    return `${nombres[Number(mes) - 1] ?? mes} de ${anio}`;
  }

  /**
   * Qué parte de la bolsa se consumió, de 0 a 100.
   *
   * Se topa en 100 para que la barra no se desborde cuando hay exceso: lo
   * que pasó del plan se dice con un número aparte, no estirando la barra
   * fuera de su caja.
   */
  readonly consumido = computed(() => {
    const e = this.estado();
    if (!e?.incluidos) return 0;
    return Math.min(100, Math.round((e.mensajes / e.incluidos) * 100));
  });

  /** El mayor gasto de una fila, para dar escala a las barras del detalle. */
  readonly topePais = computed(() => Math.max(1, ...this.detalle()?.porPais.map((p) => p.micros) ?? [1]));
  readonly topeAgente = computed(() => Math.max(1, ...this.detalle()?.porAgente.map((a) => a.micros) ?? [1]));

  anchoPais(micros: number): string {
    return `${Math.max(2, Math.round((micros / this.topePais()) * 100))}%`;
  }

  anchoAgente(micros: number): string {
    return `${Math.max(2, Math.round((micros / this.topeAgente()) * 100))}%`;
  }

  verPeriodo(p: string): void {
    // El mes en curso se mira con el recurso principal, que trae además el
    // estado del plan; los cerrados solo tienen detalle.
    this.periodo.set(p === valorDe(this.datos)?.detalle.periodo ? '' : p);
  }

  abrirTope(): void {
    const actual = this.estado()?.topeMicros;
    this.topeBorrador.set(actual === null || actual === undefined ? '' : String(actual / 1_000_000));
    this.editandoTope.set(true);
  }

  escribirTope(e: Event): void {
    this.topeBorrador.set((e.target as HTMLInputElement).value);
  }

  async guardarTope(quitar = false): Promise<void> {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.error.set(null);
    try {
      const valor = quitar ? null : Number(this.topeBorrador());
      if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
        throw new Error('El tope va en dólares, por ejemplo 50.');
      }
      await this.api.fijarTope(valor);
      this.editandoTope.set(false);
      this.datos.reload();
    } catch (e) {
      const err = e as { error?: { message?: string }; message?: string };
      this.error.set(err?.error?.message ?? err?.message ?? 'No se pudo guardar el tope.');
    } finally {
      this.guardando.set(false);
    }
  }

  readonly listaTarifas = computed(() => valorDe(this.tarifas)?.paises ?? []);
  readonly categorias = computed(() => valorDe(this.tarifas)?.categorias ?? []);
  readonly vigenteDesde = computed(() => valorDe(this.tarifas)?.vigenteDesde);

  /** Precio por mensaje: vive en la cuarta decimal, no en la segunda. */
  porMensaje(micros: number): string {
    return (micros / 1_000_000).toFixed(4);
  }

  hora(iso: string): string {
    return new Date(iso).toLocaleString('es-HN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
