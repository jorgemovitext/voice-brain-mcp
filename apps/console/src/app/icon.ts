import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'phone'
  | 'chat'
  | 'mail'
  | 'zap'
  | 'users'
  | 'sprout'
  | 'send'
  | 'chip'
  | 'inbox'
  | 'database'
  | 'check'
  | 'checks'
  | 'play'
  | 'sparkle'
  | 'clock'
  | 'note'
  | 'image'
  | 'pin'
  | 'alerta'
  | 'chevron';

/**
 * Iconos SVG de la interfaz (trazo, 24x24, heredan color y tamaño del texto).
 * Los emojis quedan reservados para el contenido del chat.
 */
@Component({
  selector: 'ui-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: inline-flex; line-height: 0; vertical-align: -0.12em; }
    svg { width: 1em; height: 1em; }
  `,
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      @switch (name()) {
        @case ('phone') {
          <path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>
        }
        @case ('chat') {
          <path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.2-4.5A9 9 0 1 1 21 12"/>
        }
        @case ('mail') {
          <rect x="3" y="5" width="18" height="14" rx="2"/>
          <path d="m3 7 9 6 9-6"/>
        }
        @case ('zap') {
          <path d="M13 2 4 14h6l-1 8 9-12h-6z"/>
        }
        @case ('users') {
          <circle cx="9" cy="8" r="3.5"/>
          <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/>
          <path d="M15.5 5.4a3 3 0 1 1 1.7 5.6"/>
          <path d="M17.5 14.8c2.3.7 4 2.4 4 5.2"/>
        }
        @case ('sprout') {
          <path d="M12 21v-7"/>
          <path d="M12 14a6 6 0 0 0-6-6H4a6 6 0 0 0 6 6z"/>
          <path d="M12 12a6 6 0 0 1 6-6h2a6 6 0 0 1-6 6z"/>
        }
        @case ('send') {
          <path d="m22 2-11 11"/>
          <path d="M22 2 15 22l-4-9-9-4z"/>
        }
        @case ('chip') {
          <rect x="6" y="6" width="12" height="12" rx="2"/>
          <path d="M10 2v4M14 2v4M10 18v4M14 18v4M2 10h4M2 14h4M18 10h4M18 14h4"/>
        }
        @case ('inbox') {
          <path d="M3 13h5l2 3h4l2-3h5"/>
          <path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>
        }
        @case ('database') {
          <ellipse cx="12" cy="5.5" rx="8" ry="3"/>
          <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/>
          <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>
        }
        @case ('check') {
          <circle cx="12" cy="12" r="9"/>
          <path d="m8.5 12.5 2.5 2.5 5-6"/>
        }
        @case ('checks') {
          <!-- "Entregado": dos tildes traslapadas, sin el círculo del check
               de arriba — ese es para estados de éxito, este es de mensajería. -->
          <path d="M18 6 7 17l-5-5"/>
          <path d="m22 10-7.5 7.5L13 16"/>
        }
        @case ('play') {
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>
        }
        @case ('sparkle') {
          <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>
          <path d="M19 15.5 19.7 17.3 21.5 18 19.7 18.7 19 20.5 18.3 18.7 16.5 18 18.3 17.3z"/>
        }
        @case ('clock') {
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 7v5l3.5 2"/>
        }
        @case ('note') {
          <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9"/>
          <path d="m18.4 2.6 2 2L13 12l-3 1 1-3z"/>
        }
        @case ('image') {
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <circle cx="8.5" cy="9.5" r="1.5"/>
          <path d="m21 15-4.5-4.5L7 20"/>
        }
        @case ('pin') {
          <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11"/>
          <circle cx="12" cy="10" r="2.5"/>
        }
        @case ('alerta') {
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"/>
          <path d="M12 9v4"/>
          <path d="M12 17h.01"/>
        }
        @case ('chevron') {
          <path d="m9 6 6 6-6 6"/>
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
}
