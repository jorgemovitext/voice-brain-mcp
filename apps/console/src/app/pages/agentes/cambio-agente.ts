import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { AgenteResumen } from '../../models';
import { valorDe } from '../../recurso';

type Modo = 'automatico' | 'preguntar' | 'nunca';

interface Regla {
  id: string;
  tema: string;
  agente: string;
  activa: boolean;
  cambios: number;
}

interface Respuesta {
  config: { modo: Modo; umbral: number; mensaje: string; reglas: Regla[] };
  plan: string;
  rol: 'admin' | 'supervisor' | 'operador';
  puedeEditar: boolean;
  motivo: 'plan' | 'rol' | null;
}

const MODOS: Array<{ id: Modo; nombre: string; texto: string }> = [
  {
    id: 'automatico',
    nombre: 'Automático',
    texto: 'Movi cambia solo, avisa al ciudadano y deja el rastro en el chat. La operadora puede deshacerlo.',
  },
  {
    id: 'preguntar',
    nombre: 'Preguntar primero',
    texto: 'Movi propone el cambio y el ciudadano lo confirma con una palabra antes de pasar.',
  },
  {
    id: 'nunca',
    nombre: 'Nunca',
    texto: 'Atiende siempre el agente que recibió y deja una nota para que la operadora derive a mano.',
  },
];

/**
 * Cómo decide Hive quién atiende cuando el tema no es del agente que recibió.
 *
 * La pantalla no decide nada: muestra y edita lo que el motor va a aplicar.
 * Por eso el riel derecho enseña la frase EXACTA que verá el ciudadano — con
 * un deslizador y tres tarjetas es fácil configurar algo que suena distinto
 * de lo que uno imaginaba, y acá eso se lee antes de guardar.
 */
@Component({
  selector: 'app-cambio-agente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './cambio-agente.html',
  styleUrl: './cambio-agente.scss',
})
export class CambioAgentePage {
  protected readonly valorDe = valorDe;
  protected readonly MODOS = MODOS;

  private readonly api = inject(BrainApiService);

  readonly datos = httpResource<Respuesta>(() => '/api/agentes/derivacion');
  readonly agentes = httpResource<{ agentes: AgenteResumen[] }>(() => '/api/agentes');

  /* El borrador local: lo guardado no cambia hasta que se aprieta guardar. */
  readonly modo = signal<Modo>('automatico');
  readonly umbral = signal(90);
  readonly mensaje = signal('');
  readonly reglas = signal<Regla[]>([]);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardado = signal(false);

  readonly puedeEditar = computed(() => valorDe(this.datos)?.puedeEditar ?? false);
  readonly motivo = computed(() => valorDe(this.datos)?.motivo ?? null);
  readonly plan = computed(() => valorDe(this.datos)?.plan ?? 'prueba');
  readonly rol = computed(() => valorDe(this.datos)?.rol ?? 'operador');

  readonly catalogo = computed(() => valorDe(this.agentes)?.agentes ?? []);
  readonly nombreDe = computed(() => {
    const porId = new Map(this.catalogo().map((a) => [a.id, a.nombre]));
    return (ref: string) => porId.get(ref) ?? 'Agente retirado';
  });

  constructor() {
    // Lo guardado llena el borrador una vez que llega.
    effect(() => {
      const c = valorDe(this.datos)?.config;
      if (!c) return;
      this.modo.set(c.modo);
      this.umbral.set(c.umbral);
      this.mensaje.set(c.mensaje);
      this.reglas.set(c.reglas);
    });
  }

  /** Cuántas veces se aplicó cada cosa, para el riel. */
  readonly cambiosDelMes = computed(() => this.reglas().reduce((t, r) => t + r.cambios, 0));
  readonly reglasActivas = computed(() => this.reglas().filter((r) => r.activa).length);

  /**
   * La frase exacta que verá el ciudadano, con un ejemplo real.
   *
   * Se arma con la primera regla activa y no con texto de muestra: lo que
   * se lee acá es lo que va a salir, incluido el agente al que deriva.
   */
  readonly muestra = computed(() => {
    const r = this.reglas().find((x) => x.activa);
    return this.mensaje()
      .replace(/\{agente\}/g, r ? this.nombreDe()(r.agente) : 'el otro agente')
      .replace(/\{tema\}/g, (r?.tema ?? 'ese tema').toLowerCase())
      .replace(/\{ciudadano\}/g, 'Marlon');
  });

  escribirMensaje(e: Event): void {
    this.mensaje.set((e.target as HTMLTextAreaElement).value);
  }

  moverUmbral(e: Event): void {
    this.umbral.set(Number((e.target as HTMLInputElement).value));
  }

  alternarRegla(id: string): void {
    if (!this.puedeEditar()) return;
    this.reglas.update((rs) => rs.map((r) => (r.id === id ? { ...r, activa: !r.activa } : r)));
  }

  cambiarDestino(id: string, e: Event): void {
    const agente = (e.target as HTMLSelectElement).value;
    this.reglas.update((rs) => rs.map((r) => (r.id === id ? { ...r, agente } : r)));
  }

  cambiarTema(id: string, e: Event): void {
    const tema = (e.target as HTMLInputElement).value;
    this.reglas.update((rs) => rs.map((r) => (r.id === id ? { ...r, tema } : r)));
  }

  agregarRegla(): void {
    if (!this.puedeEditar()) return;
    const primero = this.catalogo()[0]?.id ?? '';
    this.reglas.update((rs) => [
      ...rs,
      { id: `nueva-${rs.length + 1}`, tema: '', agente: primero, activa: true, cambios: 0 },
    ]);
  }

  quitarRegla(id: string): void {
    this.reglas.update((rs) => rs.filter((r) => r.id !== id));
  }

  async guardar(): Promise<void> {
    if (!this.puedeEditar() || this.guardando()) return;
    this.guardando.set(true);
    this.error.set(null);
    this.guardado.set(false);
    try {
      await this.api.guardarDerivacion({
        modo: this.modo(),
        umbral: this.umbral(),
        mensaje: this.mensaje(),
        // Sin tema no deriva nada y ensucia la lista: se descartan al guardar.
        reglas: this.reglas().filter((r) => r.tema.trim() && r.agente),
      });
      this.guardado.set(true);
      this.datos.reload();
    } catch (e) {
      const err = e as { error?: { message?: string }; message?: string };
      this.error.set(err?.error?.message ?? err?.message ?? 'No se pudo guardar.');
    } finally {
      this.guardando.set(false);
    }
  }
}
