import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
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
  /**
   * Los documentos que se adjuntaron en ese turno.
   *
   * Cuando están, el turno se dibuja como una ficha de archivo y no como un
   * globo de texto: el `texto` igual viaja al servidor —es la instrucción— pero
   * en pantalla lo que importa es QUÉ se subió.
   */
  docs?: string[];
}

/** Un documento ya subido y esperando enganche. */
interface Documento {
  referencia: string;
  nombre: string;
  palabras: number;
}

const ANCHO = 236;
const ALTO = 112;

/**
 * Lo que el proveedor sabe leer. Tiene que coincidir con `documentos.service.ts`.
 *
 * Se valida también acá para no hacerle subir cuatro megas al operador antes de
 * decirle que no: con una conexión de Tegucigalpa eso es un minuto perdido para
 * llegar a un 400.
 */
const TIPOS = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/html',
  'application/epub+zip',
];
const TOPE_BYTES = 4 * 1024 * 1024;

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
  protected readonly TIPOS = TIPOS.join(',');

  private readonly api = inject(BrainApiService);

  /** `?desde=documentos`: se entró por el camino de subir un reglamento. */
  readonly desde = input<string>('');

  /** El agente que el asistente creó, si ya llegó a crearlo. */
  readonly agenteId = signal<string | null>(null);

  readonly turnos = signal<Turno[]>([
    {
      de: 'asistente',
      texto:
        '¿Para qué necesitás este agente? Contame en una línea qué tiene que resolver y con quién habla. ' +
        'Si tenés un reglamento o un documento con las reglas, adjuntalo y lo armo con eso.',
    },
  ]);

  readonly texto = signal('');
  readonly pensando = signal(false);
  readonly error = signal<string | null>(null);

  /* --- Documentos ------------------------------------------------------- */

  /**
   * Los subidos en esta charla.
   *
   * Viajan en CADA turno y no una sola vez: el agente puede no existir todavía
   * cuando se sube el documento, y el servidor los engancha en cuanto exista.
   * Mandarlos siempre hace que el enganche no dependa de que un turno puntual
   * no se haya perdido.
   */
  readonly documentos = signal<Documento[]>([]);
  readonly subiendo = signal(false);
  /** Hay un archivo encima del lienzo, listo para soltar. */
  readonly arrastrando = signal(false);

  /** Lo que el agente ya puede consultar, según el servidor. */
  readonly sabeDe = computed(() => valorDe(this.agente)?.documentos ?? []);

  /** El flujo del agente que se está armando. Se relee tras cada cambio. */
  readonly flujo = httpResource<{ nodos: NodoFlujo[]; aristas: AristaFlujo[] }>(() =>
    this.agenteId() ? `/api/agentes/${this.agenteId()}/flujo` : undefined,
  );
  readonly agente = httpResource<{ nombre: string; herramientas: string[]; documentos: string[] }>(() =>
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

  /* --- Adjuntar ---------------------------------------------------------- */

  elegidos(e: Event): void {
    const input = e.target as HTMLInputElement;
    void this.adjuntar(Array.from(input.files ?? []));
    // Se limpia para que volver a elegir el MISMO archivo dispare el evento.
    input.value = '';
  }

  encima(e: DragEvent): void {
    e.preventDefault();
    this.arrastrando.set(true);
  }

  afuera(): void {
    this.arrastrando.set(false);
  }

  soltar(e: DragEvent): void {
    e.preventDefault();
    this.arrastrando.set(false);
    void this.adjuntar(Array.from(e.dataTransfer?.files ?? []));
  }

  /**
   * Sube los archivos y le pide al asistente que arme el agente con ellos.
   *
   * El envío es automático a propósito: subir un reglamento y quedarse mirando
   * un chip no es "crear el agente con el documento". El operador suelta el
   * archivo y el asistente ya está trabajando.
   */
  async adjuntar(archivos: File[]): Promise<void> {
    const utiles = archivos.filter((a) => a.size > 0);
    if (!utiles.length || this.subiendo() || this.pensando()) return;

    this.subiendo.set(true);
    this.error.set(null);

    const subidos: Documento[] = [];
    const fallidos: string[] = [];

    for (const archivo of utiles) {
      const motivo = AgenteAsistentePage.rechazo(archivo);
      if (motivo) {
        fallidos.push(`${archivo.name}: ${motivo}`);
        continue;
      }
      try {
        subidos.push(await this.api.subirDocumento(archivo));
      } catch (e) {
        fallidos.push(`${archivo.name}: ${(e as Error).message}`);
      }
    }

    this.subiendo.set(false);
    if (!subidos.length) {
      this.error.set(fallidos.join(' · '));
      return;
    }

    this.documentos.update((d) => [...d, ...subidos]);

    const nombres = subidos.map((d) => d.nombre);
    const lista = nombres.map((n) => `«${n}»`).join(' y ');
    await this.enviar(
      this.agenteId()
        ? `Subí ${lista}. Sumalo a lo que el agente ya sabe y ajustá las instrucciones para que lo consulte.`
        : `Subí ${lista}. Armá un agente que atienda con base en ese documento: creálo y empezá el flujo.`,
      nombres,
    );

    /*
     * El aviso de lo que NO subió va al final y no antes del envío: `enviar`
     * limpia el error al arrancar, así que puesto antes se borraba solo y el
     * operador se quedaba creyendo que subieron los tres archivos.
     */
    if (fallidos.length) this.error.set(fallidos.join(' · '));
  }

  /** Por qué no se puede subir, o null si se puede. */
  private static rechazo(archivo: File): string | null {
    if (archivo.size > TOPE_BYTES) {
      return `pesa ${Math.round(archivo.size / 1024 / 1024)} MB y el tope es ${TOPE_BYTES / 1024 / 1024} MB`;
    }
    // Por tipo, y si el navegador no lo informó, por extensión: en Windows un
    // .docx llega a veces con el tipo vacío.
    if (TIPOS.includes(archivo.type)) return null;
    if (/\.(pdf|docx?|txt|html?|epub)$/i.test(archivo.name)) return null;
    return 'no es un PDF ni un Word';
  }

  /* --- Conversar --------------------------------------------------------- */

  /**
   * Un turno. `forzado` lo manda la app (al adjuntar) en vez del operador.
   */
  async enviar(forzado?: string, docs?: string[]): Promise<void> {
    const texto = (forzado ?? this.texto()).trim();
    if (!texto || this.pensando()) return;

    this.turnos.update((t) => [...t, { de: 'persona', texto, docs }]);
    if (!forzado) this.texto.set('');
    this.pensando.set(true);
    this.error.set(null);

    try {
      const r = await this.api.asistenteDeAgentes(
        this.turnos().map(({ de, texto }) => ({ de, texto })),
        this.agenteId(),
        this.documentos().map(({ referencia, nombre }) => ({ referencia, nombre })),
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
