import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AristaFlujo, NodoFlujo } from '../../models';
import { valorDe } from '../../recurso';

/** Un turno del chat, como se ve en pantalla. */
interface Turno {
  de: 'persona' | 'asistente';
  texto: string;
  /** Lo que ese turno cambió de verdad en el agente. */
  cambios?: string[];
}

const ANCHO = 236;
const ALTO = 112;

/**
 * Crear un agente conversando, con el flujo a la vista.
 *
 * El lienzo de la izquierda es el mismo lenguaje del editor visual pero de
 * SOLO LECTURA: acá el editor es el chat. Se dibuja igual porque lo que se ve
 * mientras se arma tiene que ser lo mismo que se va a encontrar después en
 * `/agentes/:id/flujo` — si fueran dos dibujos distintos, el operador no
 * sabría que es la misma cosa.
 */
@Component({
  selector: 'app-agente-asistente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './agente-asistente.html',
  styleUrl: './agente-asistente.scss',
})
export class AgenteAsistentePage {
  protected readonly valorDe = valorDe;
  protected readonly ANCHO = ANCHO;
  protected readonly ALTO = ALTO;

  private readonly api = inject(BrainApiService);

  /** El agente que el asistente creó, si ya llegó a crearlo. */
  readonly agenteId = signal<string | null>(null);

  readonly turnos = signal<Turno[]>([
    {
      de: 'asistente',
      texto:
        '¿Para qué necesitás este agente? Contame en una línea qué tiene que resolver y con quién habla.',
    },
  ]);

  readonly texto = signal('');
  readonly pensando = signal(false);
  readonly error = signal<string | null>(null);

  /** El flujo del agente que se está armando. Se relee tras cada cambio. */
  readonly flujo = httpResource<{ nodos: NodoFlujo[]; aristas: AristaFlujo[] }>(() =>
    this.agenteId() ? `/api/agentes/${this.agenteId()}/flujo` : undefined,
  );
  readonly agente = httpResource<{ nombre: string; herramientas: string[] }>(() =>
    this.agenteId() ? `/api/agentes/${this.agenteId()}` : undefined,
  );

  readonly nodos = computed(() => valorDe(this.flujo)?.nodos ?? []);
  readonly aristas = computed(() => valorDe(this.flujo)?.aristas ?? []);

  constructor() {
    // Recién creado el agente todavía no tiene flujo; el recurso se dispara
    // solo al aparecer el id y se recarga con cada cambio del asistente.
    effect(() => {
      if (this.agenteId()) this.flujo.reload();
    });
  }

  escribir(e: Event): void {
    this.texto.set((e.target as HTMLTextAreaElement).value);
  }

  async enviar(): Promise<void> {
    const texto = this.texto().trim();
    if (!texto || this.pensando()) return;

    this.turnos.update((t) => [...t, { de: 'persona', texto }]);
    this.texto.set('');
    this.pensando.set(true);
    this.error.set(null);

    try {
      const r = await this.api.asistenteDeAgentes(
        this.turnos().map(({ de, texto }) => ({ de, texto })),
        this.agenteId(),
      );

      if (r.agenteId && r.agenteId !== this.agenteId()) this.agenteId.set(r.agenteId);
      this.turnos.update((t) => [
        ...t,
        { de: 'asistente', texto: r.respuesta, cambios: r.cambios.map((c) => c.detalle) },
      ]);

      // Se releen SIEMPRE que hubo cambios: el lienzo y las píldoras de
      // herramientas son la prueba de que lo que dijo que hizo, lo hizo.
      if (r.cambios.length) {
        this.flujo.reload();
        this.agente.reload();
      }
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.pensando.set(false);
    }
  }

  /** El encuadre del lienzo, con aire alrededor de los nodos. */
  readonly lienzo = computed(() => {
    const ns = this.nodos();
    if (!ns.length) return '0 0 560 420';
    const x0 = Math.min(...ns.map((n) => n.x)) - 60;
    const y0 = Math.min(...ns.map((n) => n.y)) - 60;
    const x1 = Math.max(...ns.map((n) => n.x + ANCHO)) + 60;
    const y1 = Math.max(...ns.map((n) => n.y + ALTO)) + 60;
    return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
  });

  /** La curva entre dos fases: sale por abajo y entra por arriba. */
  camino(a: AristaFlujo): string {
    const de = this.nodos().find((n) => n.id === a.desde);
    const hasta = this.nodos().find((n) => n.id === a.hasta);
    if (!de || !hasta) return '';
    const x1 = de.x + ANCHO / 2;
    const y1 = de.y + ALTO;
    const x2 = hasta.x + ANCHO / 2;
    const y2 = hasta.y;
    const m = (y1 + y2) / 2;
    /*
     * En ángulo recto y no en curva: es el trazo del tablero de la referencia,
     * y con varias salidas de una misma fase las rectas se distinguen entre sí
     * mucho mejor que dos curvas casi paralelas. El radio redondea el codo.
     */
    if (Math.abs(x1 - x2) < 2) return `M ${x1} ${y1} V ${y2}`;
    const r = 14;
    const signo = x2 > x1 ? 1 : -1;
    return [
      `M ${x1} ${y1}`,
      `V ${m - r}`,
      `Q ${x1} ${m} ${x1 + signo * r} ${m}`,
      `H ${x2 - signo * r}`,
      `Q ${x2} ${m} ${x2} ${m + r}`,
      `V ${y2}`,
    ].join(" ");
  }

  medio(a: AristaFlujo): { x: number; y: number } | null {
    const de = this.nodos().find((n) => n.id === a.desde);
    const hasta = this.nodos().find((n) => n.id === a.hasta);
    if (!de || !hasta) return null;
    return {
      x: (de.x + hasta.x) / 2 + ANCHO / 2,
      y: (de.y + ALTO + hasta.y) / 2,
    };
  }

  /** Las herramientas propias del agente, para mostrar qué puede hacer. */
  readonly herramientas = computed(() =>
    (valorDe(this.agente)?.herramientas ?? [])
      .filter((h) => h !== 'end_call' && h !== 'language_detection')
      .map((h) => h.replace(/_/g, ' ')),
  );
}
