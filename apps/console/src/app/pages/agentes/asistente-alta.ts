import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AgenteResumen } from '../../models';
import { valorDe } from '../../recurso';

/** Un paso del asistente, como se pinta arriba a la derecha. */
export type Paso = 'origen' | 'conocimiento' | 'canales' | 'revisar';

interface PlantillaVista {
  id: string;
  nombre: string;
  resumen: string;
  para: string[];
  herramientas: string[];
  fases: number;
}

interface Reparo {
  gravedad: 'aviso' | 'bloqueo';
  texto: string;
}

interface Resumen {
  agente: { id: string; nombre: string; primerMensaje: string; instrucciones: string; documentos: string[]; herramientas: string[] };
  canales: { whatsapp: boolean; voz: boolean; sms: boolean; horario: string; fueraDeHorario: 'toma' | 'avisa'; respaldo: string };
  fases: Array<{ id: string; nombre: string; tipo: string }>;
  reparos: Reparo[];
  puedeActivar: boolean;
}

const PASOS: Array<{ id: Paso; rotulo: string; titulo: string; bajada: string }> = [
  { id: 'origen', rotulo: 'Origen', titulo: 'De dónde sale', bajada: 'Qué trabajo va a hacer y para quién' },
  { id: 'conocimiento', rotulo: 'Conocimiento', titulo: 'Qué tiene que saber', bajada: 'Lo que ya está escrito, para que no lo invente' },
  { id: 'canales', rotulo: 'Canales', titulo: 'Por dónde atiende', bajada: 'El número, el horario y qué hace cuando no puede' },
  { id: 'revisar', rotulo: 'Revisar', titulo: 'Revisar y activar', bajada: 'Todo lo que armaste, antes de que atienda a alguien' },
];

/**
 * El alta de un agente, en cuatro pasos.
 *
 * El agente se crea DE VERDAD en el paso 1 y no al final: cada paso
 * siguiente trabaja sobre algo real —subirle documentos, darle un número— y
 * si alguien abandona a la mitad, lo hecho quedó. Un asistente que acumula
 * todo en memoria y recién crea al apretar «terminar» pierde el trabajo
 * entero con cerrar la pestaña.
 */
@Component({
  selector: 'app-asistente-alta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './asistente-alta.html',
  styleUrl: './asistente-alta.scss',
})
export class AsistenteAltaPage {
  protected readonly valorDe = valorDe;
  protected readonly PASOS = PASOS;

  private readonly api = inject(BrainApiService);
  private readonly router = inject(Router);

  readonly paso = signal<Paso>('origen');
  readonly agenteId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly trabajando = signal(false);

  /* --- Paso 1: origen --- */
  readonly plantillas = httpResource<PlantillaVista[]>(() => '/api/agentes/plantillas');
  readonly elegida = signal<string | null>(null);
  readonly nombre = signal('');
  readonly negocio = signal('');

  /* --- Paso 2: conocimiento --- */
  readonly documentos = signal<Array<{ referencia: string; nombre: string; palabras: number }>>([]);
  readonly subiendo = signal<string | null>(null);

  /* --- Paso 3: canales --- */
  readonly horario = signal('');
  readonly fueraDeHorario = signal<'toma' | 'avisa'>('toma');
  readonly respaldo = signal('');
  readonly numero = signal('');
  readonly cliente = signal('');

  /* --- Paso 4: revisar --- */
  readonly resumen = signal<Resumen | null>(null);
  readonly prueba = signal<Array<{ de: 'yo' | 'agente'; texto: string }>>([]);
  readonly mensajePrueba = signal('');
  readonly probando = signal(false);

  readonly catalogo = computed(() => valorDe(this.plantillas) ?? []);
  readonly indice = computed(() => PASOS.findIndex((p) => p.id === this.paso()));
  readonly actual = computed(() => PASOS[this.indice()]);

  /** Un paso está hecho cuando se pasó de él: la barra no miente hacia atrás. */
  hecho(p: Paso): boolean {
    return PASOS.findIndex((x) => x.id === p) < this.indice();
  }

  escribir(campo: 'nombre' | 'negocio' | 'horario' | 'respaldo' | 'numero' | 'cliente' | 'mensajePrueba', e: Event): void {
    this[campo].set((e.target as HTMLInputElement).value);
  }

  readonly puedeSeguirDeOrigen = computed(
    () => !!this.elegida() && !!this.nombre().trim() && !!this.negocio().trim(),
  );

  /* ===== Paso 1 → 2: acá nace el agente ===== */
  async crearAgente(): Promise<void> {
    if (!this.puedeSeguirDeOrigen() || this.trabajando()) return;
    this.trabajando.set(true);
    this.error.set(null);
    try {
      const { id } = await this.api.crearAgenteDesdePlantilla({
        plantilla: this.elegida()!,
        nombre: this.nombre().trim(),
        negocio: this.negocio().trim(),
      });
      this.agenteId.set(id);
      this.cliente.set(this.negocio().trim());
      this.paso.set('conocimiento');
    } catch (e) {
      this.error.set(AsistenteAltaPage.motivo(e));
    } finally {
      this.trabajando.set(false);
    }
  }

  /* ===== Paso 2: documentos ===== */
  async adjuntar(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const archivos = Array.from(input.files ?? []);
    input.value = '';
    const id = this.agenteId();
    if (!archivos.length || !id) return;

    this.error.set(null);
    for (const archivo of archivos) {
      this.subiendo.set(archivo.name);
      try {
        const doc = await this.api.subirDocumento(archivo);
        this.documentos.update((d) => [...d, doc]);
        await this.api.engancharDocumentos(id, [doc]);
      } catch (err) {
        this.error.set(AsistenteAltaPage.motivo(err));
      }
    }
    this.subiendo.set(null);
  }

  /* ===== Paso 3: canales ===== */
  async guardarCanales(): Promise<void> {
    const id = this.agenteId();
    if (!id || this.trabajando()) return;
    this.trabajando.set(true);
    this.error.set(null);
    try {
      await this.api.guardarCanales(id, {
        horario: this.horario().trim(),
        fueraDeHorario: this.fueraDeHorario(),
        respaldo: this.respaldo().trim(),
      });

      // La línea es opcional en el alta: un agente puede quedar armado hoy y
      // recibir su número mañana, cuando el cliente lo migre.
      const numero = this.numero().trim().replace(/[\s-]/g, '');
      if (numero) {
        await this.api.crearLinea({
          cliente: this.cliente().trim() || this.negocio().trim(),
          nombre: this.nombre().trim(),
          numero: numero.startsWith('+') ? numero : `+${numero}`,
          agente: id,
        });
      }
      await this.irARevisar();
    } catch (e) {
      this.error.set(AsistenteAltaPage.motivo(e));
    } finally {
      this.trabajando.set(false);
    }
  }

  /* ===== Paso 4: revisar ===== */
  async irARevisar(): Promise<void> {
    const id = this.agenteId();
    if (!id) return;
    this.paso.set('revisar');
    this.resumen.set(await this.api.resumenDeAgente(id).catch(() => null));
  }

  async probar(): Promise<void> {
    const id = this.agenteId();
    const texto = this.mensajePrueba().trim();
    if (!id || !texto || this.probando()) return;

    this.prueba.update((t) => [...t, { de: 'yo', texto }]);
    this.mensajePrueba.set('');
    this.probando.set(true);
    try {
      const r = await this.api.probarAgente(id, texto, this.prueba().map((t) => ({
        de: t.de === 'yo' ? ('persona' as const) : ('agente' as const),
        texto: t.texto,
      })));
      this.prueba.update((t) => [...t, { de: 'agente', texto: r.respuesta ?? 'No contestó.' }]);
    } catch (e) {
      this.error.set(AsistenteAltaPage.motivo(e));
    } finally {
      this.probando.set(false);
    }
  }

  async activar(): Promise<void> {
    const id = this.agenteId();
    if (!id || this.trabajando()) return;
    this.trabajando.set(true);
    this.error.set(null);
    try {
      await this.api.ponerAgenteActivo(id);
      await this.router.navigate(['/agentes']);
    } catch (e) {
      this.error.set(AsistenteAltaPage.motivo(e));
    } finally {
      this.trabajando.set(false);
    }
  }

  volverA(p: Paso): void {
    // Solo hacia atrás: saltar adelante dejaría pasos sin completar.
    if (PASOS.findIndex((x) => x.id === p) <= this.indice()) this.paso.set(p);
  }

  private static motivo(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo completar. Probá de nuevo.';
  }
}
