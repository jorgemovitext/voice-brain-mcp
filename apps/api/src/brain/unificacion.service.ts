import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AtencionService } from '../shared/atencion.service';
import { SettingsService } from '../shared/settings.service';
import { BrainService } from './brain.service';

/**
 * Deja un solo hilo por número.
 *
 * Los duplicados los dejó el emparejado por texto exacto: hasta que se empezó
 * a comparar por dígitos, "+504 9761-6546" y "50497616546" eran dos personas
 * distintas. Ya no se crean nuevos, pero los viejos siguen ahí, y partían la
 * conversación en dos — con la mitad de los mensajes en cada uno.
 */
@Injectable()
export class UnificacionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UnificacionService.name);

  /** Clave de la última corrida, para que no la repitan todas las instancias. */
  private static readonly CLAVE = 'unificacion:ultima';
  private static readonly CADA_MS = 5 * 60_000;

  constructor(
    private readonly brain: BrainService,
    private readonly atencion: AtencionService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Al arrancar, no al responder.
   *
   * Acá sí se puede esperar: el arranque ocurre ANTES de atender la primera
   * petición, así que la lambda todavía no se congela. Colgarlo de una
   * respuesta sería repetir el error que hizo que el rescate de conversaciones
   * no ocurriera nunca en producción.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.siToca();
    } catch (err) {
      // Que falle no puede impedir que la API levante.
      this.logger.warn(`No se pudo unificar al arrancar: ${(err as Error).message}`);
    }
  }

  /**
   * Corre como mucho una vez cada 5 minutos entre TODAS las instancias.
   *
   * En serverless cada arranque en frío llamaría a esto, y son muchos. La
   * ventana vive en la DB porque la memoria del proceso no se comparte; sin
   * eso, dos instancias podrían fusionar el mismo grupo a la vez.
   */
  async siToca(): Promise<Array<{ keepId: string; dropIds: string[] }>> {
    const ultima = await this.settings.get<number>(UnificacionService.CLAVE);
    if (ultima && Date.now() - ultima < UnificacionService.CADA_MS) return [];
    await this.settings.set(UnificacionService.CLAVE, Date.now());
    return this.ahora();
  }

  /** Sin ventana: la corrida manual del endpoint. */
  async ahora(): Promise<Array<{ keepId: string; dropIds: string[] }>> {
    const hechas = await this.brain.unificarPorTelefono();

    for (const { keepId, dropIds } of hechas) {
      /*
       * El hilo no puede perder a su dueño al fusionarse.
       *
       * "Quién atiende" se guarda por contactId y vive fuera del Brain, así
       * que la fusión no lo mueve sola: si el tomado era uno de los que
       * desaparecen, el hilo resultante quedaría sin operador y los mensajes
       * del ciudadano volverían a rebotar con "nadie tomó esta conversación".
       *
       * Si el que sobrevive YA está tomado, se respeta: es el más reciente y
       * pisarlo con el de un duplicado sería retroceder.
       */
      if ((await this.atencion.de(keepId)).operador) continue;

      for (const id of dropIds) {
        const { operador } = await this.atencion.de(id);
        if (!operador) continue;
        await this.atencion.tomar(keepId, operador);
        this.logger.log(`La atención de ${id} pasó a ${keepId} (${operador})`);
        break;
      }
    }

    if (hechas.length) this.logger.log(`Unificación: ${hechas.length} número(s) con duplicados`);
    return hechas;
  }
}
