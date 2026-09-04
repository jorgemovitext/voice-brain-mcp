import { ChangeDetectionStrategy, Component, output, input } from '@angular/core';
import { Icon } from '../../icon';
import { VoiceNebula } from '../../nebula';
import { etiquetaPaso, fechaCorta, horaCorta, recorte } from '../../ui';

/** En qué punto está la llamada que se disparó desde acá. */
export type EstadoLlamada = 'idle' | 'calling' | 'ended';

/** El ánimo, ya resuelto a etiqueta, clase y porcentaje de barra. */
export interface Animo {
  label: string;
  cls: string;
  pct: number;
}

/** El caso del CRM, tal como lo devuelve el expediente. */
export interface CasoCrm {
  hay: boolean;
  motivo?: string;
  asunto?: string;
  etapa?: string;
  cerrado?: boolean;
  creado?: string;
  actualizado?: string;
}

/** La ficha que el agente arma mientras conversa. */
export interface FichaViva {
  actualizada: string;
  campos: Array<{ clave: string; rotulo: string; valor: string; recien: boolean }>;
}

/** Un paso del flujo con lo que ese paso aportó. */
export interface HitoFlujo {
  paso: string;
  occurredAt?: string;
  nuevos: Array<{ clave: string; valor: string }>;
}

/**
 * El resumen de la conversación, con de dónde salió.
 *
 * `texto` y `fuente` admiten `null` porque así vienen del expediente: el
 * proveedor manda el campo vacío cuando no redactó nada.
 */
export interface ResumenConversacion {
  texto?: string | null;
  fuente?: string | null;
  capturado: Array<{ campo: string; valor: string }>;
}

/**
 * El panel derecho del hilo: avatar de voz, estado emocional, caso del CRM,
 * la ficha que el agente va armando y el resumen.
 *
 * Es un componente aparte y no un trozo de la vista del contacto porque su
 * hoja de estilos es suya: la de la vista llegó a 32 kB —el techo del
 * presupuesto `anyComponentStyle` de Angular— y cualquier retoque rompía el
 * build. Partiendo por piezas, cada una se mide sola.
 *
 * No decide nada: recibe todo resuelto y avisa cuando hay que llamar o dejar
 * de observar. La lógica sigue viviendo en la vista, que es la que sondea.
 */
@Component({
  selector: 'contexto-vivo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, VoiceNebula],
  templateUrl: './contexto-vivo.html',
  styleUrl: './contexto-vivo.scss',
})
export class ContextoVivo {
  readonly nombre = input<string>('Contacto');
  readonly estado = input<EstadoLlamada>('idle');
  readonly cronometro = input<string>('00:00');
  /** Por qué no salió la llamada, cuando el proveedor la rechazó. */
  readonly aviso = input<string | null>(null);

  readonly tendencia = input<string | undefined>(undefined);
  /** El ánimo lo está poniendo el agente en cada turno, no un histórico. */
  readonly animoEnVivo = input(false);
  readonly animo = input<Animo | null>(null);

  readonly caso = input<CasoCrm | null>(null);
  readonly ticket = input<string | null>(null);

  readonly ficha = input<FichaViva | null>(null);
  readonly hitos = input<HitoFlujo[]>([]);
  readonly resumen = input<ResumenConversacion | null>(null);

  readonly llamar = output<void>();
  readonly colgar = output<void>();

  readonly fechaCorta = fechaCorta;
  readonly horaCorta = horaCorta;
  readonly recorte = recorte;
  readonly etiquetaPaso = etiquetaPaso;
}
