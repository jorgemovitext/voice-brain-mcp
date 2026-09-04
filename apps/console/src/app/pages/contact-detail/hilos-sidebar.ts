import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ContactListItem } from '../../models';
import { Icon } from '../../icon';
import { channelColor, channelIconName, channelLabel, inicialesDe } from '../../ui';

/** Un hilo de la lista, ya resuelto con lo que aporta el flujo. */
export interface HiloListado extends ContactListItem {
  /** El agente está conversando ahora y todavía no hay mensajes que mostrar. */
  enCurso: boolean;
  /** Se quedó sin respuesta y nadie cerró el caso. */
  inconclusa: boolean;
  /** Lo más reciente contando mensajes Y avances del flujo. */
  cuando: string;
}

/**
 * La columna de conversaciones de /conversations.
 *
 * Es un componente aparte y no un trozo del detalle del contacto porque su
 * hoja de estilos es suya: la del detalle llegó a 32 kB —el techo del
 * presupuesto de Angular— y cualquier retoque visual rompía el build. Partirla
 * por piezas es lo que el presupuesto quiere medir.
 *
 * No trae datos: recibe los hilos ya resueltos. Quien los arma es la vista,
 * que ya los sondea para otras cosas.
 */
@Component({
  selector: 'hilos-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './hilos-sidebar.html',
  styleUrl: './hilos-sidebar.scss',
})
export class HilosSidebar {
  readonly hilos = input.required<HiloListado[]>();
  /** El hilo abierto, para marcarlo. */
  readonly activo = input<string | null>(null);
  /** Ruta base de cada fila: cambia según desde dónde se entró. */
  readonly base = input('/conversations');

  readonly channelColor = channelColor;
  readonly channelIconName = channelIconName;
  readonly channelLabel = channelLabel;

  /**
   * Los hilos partidos por antigüedad.
   *
   * Una lista larga de filas iguales se lee como un muro; en tramos se lee
   * como "lo de hoy, y lo de antes". Los rótulos solo aparecen cuando hay más
   * de un tramo: con todo del mismo día, un título suelto sobraría.
   */
  readonly porTramo = computed(() => {
    const hoy = new Date().toDateString();
    const ayer = new Date(Date.now() - 86_400_000).toDateString();
    const tramoDe = (iso: string) => {
      const d = new Date(iso).toDateString();
      return d === hoy ? 'Hoy' : d === ayer ? 'Ayer' : 'Antes';
    };

    const tramos: Array<{ titulo: string; hilos: HiloListado[] }> = [];
    for (const h of this.hilos()) {
      const titulo = tramoDe(h.cuando);
      const ultimo = tramos[tramos.length - 1];
      if (ultimo?.titulo === titulo) ultimo.hilos.push(h);
      else tramos.push({ titulo, hilos: [h] });
    }
    return tramos;
  });

  readonly inicialesDe = inicialesDe;

  preview(c: HiloListado): string {
    const texto = c.lastInteraction?.summary ?? '';
    /*
     * Un turno puede no tener palabras: la transcripción de una llamada donde
     * el vecino no llegó a decir nada entra literalmente como "...", y esa fila
     * quedaba con tres puntos de vista previa, que no es información, es un
     * hueco. Se dice entonces QUÉ fue, que es lo poco que sí se sabe.
     */
    if (!/[\p{L}\p{N}]/u.test(texto)) {
      if (!c.lastInteraction) return 'Sin mensajes todavía';
      return c.lastInteraction.channel === 'voice' ? 'Llamada' : 'Mensaje sin texto';
    }
    return texto.length > 46 ? `${texto.slice(0, 45)}…` : texto;
  }

  /** Hora si es de hoy, día y mes si no: en una lista, el año sobra. */
  cuandoCorto(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    const hoy = new Date().toDateString() === date.toDateString();
    return hoy
      ? date.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString('es-NI', { day: '2-digit', month: 'short' });
  }
}
