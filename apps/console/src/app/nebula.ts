import { ChangeDetectionStrategy, Component, OnDestroy, effect, input, signal } from '@angular/core';

/**
 * Avatar de voz tipo nebulosa: capas de "gas" (blobs con blur + blend screen)
 * sobre un remolino cónico que gira, en deriva constante (idle).
 *
 * Con [active]=true (llamada en curso) se simula la envolvente del audio con
 * un random-walk tipo habla (~11 ticks/seg): la amplitud escala y abrillanta
 * la nebulosa y mueve las barras de sonido.
 * // Hook real: si algún día hay audio de verdad, alimentar `amp` desde un
 * // AnalyserNode de WebAudio en lugar del random-walk.
 */
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
      <span class="neb__scale">
        <span class="neb__disc">
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

    /* Halo exterior: respira solo y se intensifica con la voz */
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

    /* Escala/brillo reactivo al sonido */
    .neb__scale {
      position: absolute;
      inset: 0;
      scale: calc(1 + var(--amp) * 0.2);
      filter: brightness(calc(0.95 + var(--amp) * 0.55)) saturate(calc(1 + var(--amp) * 0.3));
      transition: scale 100ms linear, filter 100ms linear;
    }

    .neb__disc {
      position: absolute;
      inset: 0;
      border-radius: 50%;
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
      border-radius: 50%;
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
  /** Diámetro en px. */
  readonly size = input(150);

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
