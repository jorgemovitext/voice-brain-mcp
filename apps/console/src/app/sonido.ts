import { Injectable, signal } from '@angular/core';

/**
 * Los avisos sonoros de la consola.
 *
 * Se sintetizan con WebAudio en vez de cargar archivos: son tonos de medio
 * segundo, y un `.mp3` por cada uno serían tres pedidos de red y assets que
 * mantener para algo que se describe en cuatro números.
 *
 * Cada evento suena distinto A PROPÓSITO. Quien atiende la Línea 100 no está
 * mirando la pantalla todo el tiempo; el punto es que pueda distinguir sin
 * levantar la vista si entró una conversación nueva o si una que ya conocía
 * avanzó un paso.
 */

export type Aviso =
  /** Conversación nueva: alguien acaba de escribir por primera vez. */
  | 'nueva'
  /** El flujo avanzó de nodo en una conversación abierta. */
  | 'avance'
  /** El caso se escaló al despacho: es el que tiene que interrumpir. */
  | 'escalado';

/** Cada aviso, en notas. Frecuencias en Hz y duraciones en segundos. */
const AVISOS: Record<Aviso, { notas: number[]; paso: number; largo: number; volumen: number }> = {
  // Dos notas que suben: algo empieza. Es el más presente de los tres.
  nueva: { notas: [660, 880], paso: 0.11, largo: 0.22, volumen: 0.16 },
  // Una nota corta y sola: el caso se movió, no requiere que sueltes lo que
  // estás haciendo.
  avance: { notas: [520], paso: 0, largo: 0.13, volumen: 0.08 },
  // Tres notas descendentes: la única que suena a alarma.
  escalado: { notas: [880, 740, 590], paso: 0.13, largo: 0.3, volumen: 0.2 },
};

const CLAVE_SILENCIO = 'brain:sonido:silenciado';

@Injectable({ providedIn: 'root' })
export class Sonido {
  /** Persiste entre sesiones: quien lo silencia no quiere pelearlo cada día. */
  readonly silenciado = signal(localStorage.getItem(CLAVE_SILENCIO) === '1');

  private ctx?: AudioContext;

  alternar(): void {
    const nuevo = !this.silenciado();
    this.silenciado.set(nuevo);
    localStorage.setItem(CLAVE_SILENCIO, nuevo ? '1' : '0');
    // Un toque al desilenciar: confirma que funciona Y desbloquea el audio,
    // que el navegador no habilita hasta que hay un gesto del usuario.
    if (!nuevo) this.tocar('avance');
  }

  tocar(aviso: Aviso): void {
    if (this.silenciado()) return;
    try {
      const ctx = this.contexto();
      // Pestaña de fondo o audio todavía bloqueado: no vale la pena insistir.
      if (ctx.state === 'suspended') void ctx.resume();

      const { notas, paso, largo, volumen } = AVISOS[aviso];
      notas.forEach((hz, i) => this.nota(ctx, hz, ctx.currentTime + i * paso, largo, volumen));
    } catch {
      // Sin WebAudio (o sin permiso) la consola sigue funcionando igual: el
      // sonido es un extra, nunca un requisito.
    }
  }

  private contexto(): AudioContext {
    // Perezoso: crearlo al arrancar la app lo dejaría suspendido y encima
    // gasta un recurso del navegador aunque nadie oiga nada.
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  private nota(ctx: AudioContext, hz: number, cuando: number, largo: number, volumen: number): void {
    const osc = ctx.createOscillator();
    const gan = ctx.createGain();
    // Seno: un cuadrado o un diente de sierra a este volumen se vuelven
    // estridentes en una oficina.
    osc.type = 'sine';
    osc.frequency.value = hz;

    /*
     * La envolvente es lo que separa un aviso de un pitido: sin el ataque y
     * la caída suaves, el corte abrupto de la onda produce un clic audible.
     */
    gan.gain.setValueAtTime(0, cuando);
    gan.gain.linearRampToValueAtTime(volumen, cuando + 0.012);
    gan.gain.exponentialRampToValueAtTime(0.0001, cuando + largo);

    osc.connect(gan).connect(ctx.destination);
    osc.start(cuando);
    osc.stop(cuando + largo + 0.02);
  }
}
