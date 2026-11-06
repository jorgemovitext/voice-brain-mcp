import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { BrainApiService } from '../../brain-api.service';
import { Categoria, PanoramaSeguimiento, SecuenciaSeguimiento } from '../../models';
import { valorDe } from '../../recurso';

const NOMBRE_CATEGORIA: Record<Categoria, string> = {
  servicio: 'Respuesta',
  utilidad: 'Aviso útil',
  autenticacion: 'Código',
  marketing: 'Promoción',
};

/** Nombre del tipo de agente al que le sirve cada secuencia. */
const NOMBRE_PLANTILLA: Record<string, string> = {
  recepcionista: 'Recepcionista',
  ventas: 'Ventas y leads',
  citas: 'Agenda de citas',
  reportes: 'Reportes y reclamos',
  postventa: 'Posventa',
};

/**
 * Seguimiento: lo que el agente manda sin que le escriban.
 *
 * La pantalla está construida alrededor de una sola idea: encender una
 * secuencia cuesta plata y puede molestar a gente, así que las dos cosas se
 * dicen ANTES del interruptor y no en una ayuda escondida. Por eso cada
 * tarjeta muestra los mensajes que manda, lo que costarían al mes y los
 * frenos que la paran — y el estimado asume el peor caso: que nadie contesta
 * y todos reciben todos los pasos.
 */
@Component({
  selector: 'app-seguimiento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './seguimiento.html',
  styleUrl: './seguimiento.scss',
})
export class SeguimientoPage {
  protected readonly valorDe = valorDe;
  private readonly api = inject(BrainApiService);
  private readonly auth = inject(AuthService);

  /** Cuánta gente se estima por mes. Mueve todos los costos de la pantalla. */
  readonly personas = signal(100);

  readonly datos = httpResource<PanoramaSeguimiento>(
    () => `/api/seguimiento?personas=${this.personas()}`,
  );

  readonly guardando = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  readonly disponible = computed(() => valorDe(this.datos)?.disponible ?? false);
  readonly secuencias = computed(() => valorDe(this.datos)?.secuencias ?? []);
  readonly noMolestar = computed(() => valorDe(this.datos)?.noMolestar);
  readonly maxPorPersona = computed(() => valorDe(this.datos)?.maxPorPersonaSemana ?? 3);

  readonly enCurso = computed(() => {
    const porId = new Map((valorDe(this.datos)?.enCurso ?? []).map((e) => [e.secuencia, e.personas]));
    return (id: string) => porId.get(id) ?? 0;
  });

  /** Lo que costaría todo lo encendido, junto. Es el número que importa. */
  readonly costoEncendido = computed(() =>
    this.secuencias()
      .filter((s) => s.activa)
      .reduce((t, s) => t + s.estimado.micros, 0),
  );

  readonly mensajesEncendidos = computed(() =>
    this.secuencias()
      .filter((s) => s.activa)
      .reduce((t, s) => t + s.estimado.mensajes, 0),
  );

  dolares(micros: number): string {
    return `US$ ${(micros / 1_000_000).toFixed(2)}`;
  }

  categoria(c: Categoria): string {
    return NOMBRE_CATEGORIA[c] ?? c;
  }

  paraQuien(s: SecuenciaSeguimiento): string {
    return s.paraPlantillas.map((p) => NOMBRE_PLANTILLA[p] ?? p).join(' · ');
  }

  /**
   * «-24 h» → «1 día antes»; «3 h» → «a las 3 horas»; «24 h» → «al día».
   *
   * Las horas y los días no llevan el mismo artículo en español: «a las 3
   * horas» se lee bien y «a las 3 días» no. Se arma por separado en vez de
   * pegarle un prefijo a los dos.
   */
  cuando(horas: number): string {
    const abs = Math.abs(horas);
    const dias = Math.round(abs / 24);

    let texto: string;
    if (abs < 24) {
      texto = horas < 0 ? `${abs} ${abs === 1 ? 'hora' : 'horas'}` : abs === 1 ? 'a la hora' : `a las ${abs} horas`;
    } else {
      const cuantos = `${dias} ${dias === 1 ? 'día' : 'días'}`;
      texto = horas < 0 ? cuantos : dias === 1 ? 'al día' : `a los ${dias} días`;
    }
    return horas < 0 ? `${texto} antes` : texto;
  }

  /**
   * El mensaje tal como le llega a la persona, no con los huecos a la vista.
   *
   * Un «Hola {nombre}, tu cita en {negocio}» en pantalla obliga a imaginarse
   * el resultado, y lo que hay que poder juzgar antes de encender esto es si
   * el texto suena bien — no si las variables están bien escritas.
   */
  comoLlega(texto: string): string {
    return texto
      .replace(/\{nombre\}/g, 'Marlon')
      .replace(/\{negocio\}/g, this.auth.user()?.empresa?.trim() || 'tu negocio')
      .replace(/\{agente\}/g, 'el asistente');
  }

  moverPersonas(e: Event): void {
    this.personas.set(Number((e.target as HTMLInputElement).value));
  }

  async alternar(s: SecuenciaSeguimiento): Promise<void> {
    if (!this.disponible() || this.guardando()) return;
    this.guardando.set(s.id);
    this.error.set(null);
    try {
      await this.api.guardarSeguimiento({ activas: { [s.id]: !s.activa } });
      this.datos.reload();
    } catch (e) {
      const err = e as { error?: { message?: string }; message?: string };
      this.error.set(err?.error?.message ?? err?.message ?? 'No se pudo guardar.');
    } finally {
      this.guardando.set(null);
    }
  }

  async bajarTope(valor: number): Promise<void> {
    if (this.guardando()) return;
    this.guardando.set('tope');
    this.error.set(null);
    try {
      await this.api.guardarSeguimiento({ maxPorPersonaSemana: valor });
      this.datos.reload();
    } catch (e) {
      const err = e as { error?: { message?: string }; message?: string };
      this.error.set(err?.error?.message ?? err?.message ?? 'No se pudo guardar el tope.');
    } finally {
      this.guardando.set(null);
    }
  }
}
