import { ChangeDetectionStrategy, Component, OnDestroy, effect, input, signal } from '@angular/core';

/**
 * Avatar del agente: una CELDA DE PANAL — hexágono de esquinas redondeadas —
 * con la nebulosa de gas adentro (blobs con blur + blend screen sobre un
 * remolino cónico) y un anillo de luces recorriendo el borde.
 *
 * El anillo lleva dos capas sobre el mismo trazo hexagonal:
 *  - puntitos fijos a lo largo de todo el perímetro (los "leds" tenues), y
 *  - un cometa de segmentos brillantes que barre el borde, como un
 *    ecualizador dando la vuelta. En reposo pasea lento; con [active]=true
 *    (el agente hablando/respondiendo) acelera y su brillo y grosor siguen
 *    la envolvente de la voz.
 *
 * Con [active]=true la envolvente se simula con un random-walk tipo habla
 * (~11 ticks/seg) que también agita la nebulosa y las barras de sonido.
 * // Hook real: si algún día hay audio de verdad, alimentar `amp` desde un
 * // AnalyserNode de WebAudio en lugar del random-walk.
 *
 * Los defs SVG (gradiente y clip) llevan id único por instancia: si fueran
 * compartidos y la primera instancia saliera del DOM, las demás perderían la
 * referencia (clásica trampa de los url(#id) de SVG).
 */

/** Hexágono "flat-top" (celda de panal) con esquinas redondeadas, en 0..100. */
const HEX =
  'M 90 60.4 L 79 79.4 Q 73 89.8 61 89.8 L 39 89.8 Q 27 89.8 21 79.4 ' +
  'L 10 60.4 Q 4 50 10 39.6 L 21 20.6 Q 27 10.2 39 10.2 L 61 10.2 ' +
  'Q 73 10.2 79 20.6 L 90 39.6 Q 96 50 90 60.4 Z';

/** El mismo trazo en coordenadas 0..1 (clipPath objectBoundingBox). */
const HEX_CLIP =
  'M.9.604 L.79.794 Q.73.898.61.898 L.39.898 Q.27.898.21.794 ' +
  'L.1.604 Q.04.5.1.396 L.21.206 Q.27.102.39.102 L.61.102 ' +
  'Q.73.102.79.206 L.9.396 Q.96.5.9.604 Z';

let siguienteUid = 0;

@Component({
  selector: 'voice-nebula',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="neb"
      [class.neb--live]="active()"
      [style.width.px]="size()"
      [style.height.px]="size()"
      [style.--amp]="amp()"
    >
      <span class="neb__glow"></span>

      <svg class="neb__ring" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <linearGradient [attr.id]="'nebGrad' + uid" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f34700" />
            <stop offset="0.4" stop-color="#d63aa8" />
            <stop offset="0.72" stop-color="#7c5cff" />
            <stop offset="1" stop-color="#00bafe" />
          </linearGradient>
          <clipPath [attr.id]="'nebClip' + uid" clipPathUnits="objectBoundingBox">
            <path [attr.d]="hexClip" />
          </clipPath>
        </defs>
        <path class="ring ring--glow" [attr.stroke]="grad" [attr.d]="hex" pathLength="100" />
        <path class="ring ring--line" [attr.stroke]="grad" [attr.d]="hex" pathLength="100" />
        <path class="ring ring--ticks" [attr.d]="hex" pathLength="100" />
        <path class="ring ring--comet-glow" [attr.stroke]="grad" [attr.d]="hex" pathLength="100" />
        <path class="ring ring--comet" [attr.d]="hex" pathLength="100" />
      </svg>

      <span class="neb__scale">
        <span class="neb__disc" [style.clip-path]="clip">
          <span class="neb__swirl"></span>
          <span class="neb__blob neb__blob--a"></span>
          <span class="neb__blob neb__blob--b"></span>
          <span class="neb__blob neb__blob--c"></span>
          <span class="neb__shade"></span>
        </span>
      </span>
    </div>
    @if (active()) {
      <div class="neb-bars">
        @for (h of bars(); track $index) {
          <i [style.height.px]="h"></i>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 0.6rem;
    }

    .neb {
      position: relative;
      --amp: 0;
    }

    /* Halo exterior: respira solo y se intensifica con la voz.
       Va tan difuminado que su forma no se distingue: no hace falta hexagonarlo. */
    .neb__glow {
      position: absolute;
      inset: -22%;
      border-radius: 50%;
      background:
        radial-gradient(circle at 32% 35%, rgba(243, 71, 0, 0.4), transparent 60%),
        radial-gradient(circle at 68% 60%, rgba(0, 186, 254, 0.38), transparent 62%);
      filter: blur(26px);
      opacity: calc(0.55 + var(--amp) * 0.45);
      animation: neb-breathe 6s ease-in-out infinite;
      transition: opacity 100ms linear;
    }

    /* ===== Anillo hexagonal de luces ===== */
    .neb__ring {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .ring {
      fill: none;
      stroke-linecap: round;
    }

    /* Resplandor del borde */
    .ring--glow {
      stroke-width: 5;
      filter: blur(5px);
      opacity: calc(0.35 + var(--amp) * 0.5);
      transition: opacity 100ms linear;
    }

    /* El trazo fino del hexágono */
    .ring--line {
      stroke-width: 1.4;
      opacity: 0.85;
    }

    /* Los "leds" tenues de todo el perímetro, con deriva lenta */
    .ring--ticks {
      stroke: #eaf2ff;
      stroke-width: 2.3;
      stroke-dasharray: 0.9 2.4;
      opacity: 0.42;
      animation: ring-sweep 40s linear infinite;
    }

    /* Cometa: ráfaga de segmentos brillantes que da la vuelta al borde
       (dasharray = 8 segmentos cortos + un hueco de 77: pathLength 100). */
    .ring--comet-glow {
      stroke-width: calc(3px + var(--amp) * 3px);
      stroke-dasharray: 22 78;
      filter: blur(3px);
      opacity: calc(0.3 + var(--amp) * 0.65);
      animation: ring-sweep 9s linear infinite;
      transition: opacity 100ms linear, stroke-width 100ms linear;
    }

    .ring--comet {
      stroke: #fff;
      stroke-width: calc(2.2px + var(--amp) * 2.2px);
      stroke-dasharray: 2 1 2 1 2 1 2 1 2 1 2 1 2 1 2 77;
      opacity: calc(0.5 + var(--amp) * 0.5);
      animation: ring-sweep 9s linear infinite;
      transition: opacity 100ms linear, stroke-width 100ms linear;
    }

    /* Hablando: el barrido corre y brilla más */
    .neb--live .ring--comet,
    .neb--live .ring--comet-glow {
      animation-duration: 2.6s;
    }

    /* ===== Nebulosa interior (recortada a la celda) ===== */

    /* Escala/brillo reactivo al sonido; el inset deja ver el anillo alrededor */
    .neb__scale {
      position: absolute;
      inset: 7%;
      scale: calc(1 + var(--amp) * 0.16);
      filter: brightness(calc(0.95 + var(--amp) * 0.55)) saturate(calc(1 + var(--amp) * 0.3));
      transition: scale 100ms linear, filter 100ms linear;
    }

    .neb__disc {
      position: absolute;
      inset: 0;
      overflow: hidden;
      box-shadow: inset 0 0 28px rgba(255, 255, 255, 0.12);
    }

    /* Remolino de color de fondo */
    .neb__swirl {
      position: absolute;
      inset: -28%;
      background: conic-gradient(from 0deg, #f34700, #ff9d5c, #00bafe, #7c5cff, #d63aa8, #f34700);
      filter: blur(16px) saturate(1.15);
      animation: neb-spin 16s linear infinite;
    }

    /* Nubes de gas: derivan cada una a su ritmo, mezcladas en screen */
    .neb__blob {
      position: absolute;
      width: 68%;
      height: 68%;
      border-radius: 50%;
      mix-blend-mode: screen;
      filter: blur(12px);
    }

    .neb__blob--a {
      left: -8%;
      top: -4%;
      background: radial-gradient(circle, rgba(255, 157, 92, 0.95), transparent 68%);
      animation: neb-drift-a 9s ease-in-out infinite alternate;
    }

    .neb__blob--b {
      right: -10%;
      top: 14%;
      background: radial-gradient(circle, rgba(0, 186, 254, 0.9), transparent 66%);
      animation: neb-drift-b 12s ease-in-out infinite alternate;
    }

    .neb__blob--c {
      left: 16%;
      bottom: -12%;
      background: radial-gradient(circle, rgba(124, 92, 255, 0.85), transparent 66%);
      animation: neb-drift-c 10.5s ease-in-out infinite alternate;
    }

    /* Sombra inferior para volumen */
    .neb__shade {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 62% 72%, rgba(6, 11, 22, 0.5), transparent 62%);
    }

    /* En llamada todo se agita más rápido */
    .neb--live .neb__swirl { animation-duration: 5.5s; }
    .neb--live .neb__blob--a { animation-duration: 3.2s; }
    .neb--live .neb__blob--b { animation-duration: 4.1s; }
    .neb--live .neb__blob--c { animation-duration: 3.6s; }

    /* Barras de sonido, movidas por la misma envolvente */
    .neb-bars {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 24px;

      i {
        width: 4px;
        border-radius: 3px;
        background: var(--secondary, #00bafe);
        transition: height 90ms linear;
      }
    }

    @keyframes ring-sweep {
      to { stroke-dashoffset: -100; }
    }

    @keyframes neb-spin {
      to { transform: rotate(360deg); }
    }

    @keyframes neb-breathe {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.07); }
    }

    @keyframes neb-drift-a {
      0% { transform: translate(0, 0) scale(1); }
      50% { transform: translate(14%, 10%) scale(1.18); }
      100% { transform: translate(-6%, 16%) scale(0.92); }
    }

    @keyframes neb-drift-b {
      0% { transform: translate(0, 0) scale(1.05); }
      50% { transform: translate(-16%, 8%) scale(0.9); }
      100% { transform: translate(-4%, -14%) scale(1.2); }
    }

    @keyframes neb-drift-c {
      0% { transform: translate(0, 0) scale(0.95); }
      50% { transform: translate(10%, -12%) scale(1.15); }
      100% { transform: translate(-12%, -4%) scale(1); }
    }
  `,
})
export class VoiceNebula implements OnDestroy {
  /** true durante la llamada: activa la reactividad "al sonido". */
  readonly active = input(false);
  /** Ancho en px. */
  readonly size = input(150);

  readonly uid = ++siguienteUid;
  readonly hex = HEX;
  readonly hexClip = HEX_CLIP;
  readonly grad = `url(#nebGrad${this.uid})`;
  readonly clip = `url(#nebClip${this.uid})`;

  /** Envolvente 0..1 de la "voz" (simulada en mock). */
  readonly amp = signal(0);
  readonly bars = signal<number[]>([6, 10, 8, 12, 7]);

  private timer?: ReturnType<typeof setInterval>;
  private target = 0;

  constructor() {
    effect(() => (this.active() ? this.start() : this.stop()));
  }

  /** Random-walk con forma de habla: ráfagas con pausas. */
  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // De vez en cuando cambia el objetivo: pausa (bajo) o fonación (alto).
      if (Math.random() < 0.18) {
        this.target = Math.random() < 0.25 ? 0.04 : 0.35 + Math.random() * 0.65;
      }
      const amp = this.amp() + (this.target - this.amp()) * 0.35;
      this.amp.set(amp);
      this.bars.set(this.bars().map(() => 5 + amp * 19 * (0.5 + Math.random() * 0.9)));
    }, 90);
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.amp.set(0);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }
}
