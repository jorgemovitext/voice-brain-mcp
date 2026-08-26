import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../shared/settings.service';

/**
 * Toma de conversación pedida desde la consola, para una conversación que
 * TODAVÍA está corriendo.
 *
 * Por qué existe: la API v2 de NL Pearl no expone takeover ni forma de
 * escribir dentro de una conversación en curso — se probaron las 15 rutas
 * plausibles y las 15 responden 404. El único punto donde el flujo nos
 * escucha durante la conversación son sus nodos de avance, que ya nos pegan
 * a `/webhooks/nlpearl/avance` en cada paso.
 *
 * Entonces el rodeo es: la consola marca acá la petición, y la respuesta del
 * siguiente avance lleva `forceHandoff: true`. Del lado de NL Pearl hay que
 * mapear ese campo a una variable y agregarle a cada nodo de avance una
 * transición condicional hacia `handoffNoEmergency`.
 *
 * OJO con lo que esto NO es: mientras el flujo no tenga esa transición, la
 * bandera no hace nada. Está lista para el día que se pueda tocar el flujo.
 *
 * El costo del rodeo es la latencia: el handoff ocurre en el SIGUIENTE paso
 * del flujo, o sea que puede tardar un turno entero del ciudadano.
 */

/** Clave por conversación: la petición es de una charla, no del contacto. */
const clave = (conversationId: string) => `handoff:${conversationId}`;

export interface PeticionHandoff {
  /** Quién la pidió, para el rastro. */
  operador: string;
  pedidoAt: string;
  /** Cuándo se le entregó al flujo; sin esto, sigue pendiente. */
  entregadoAt?: string;
}

@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  /**
   * Una petición vieja no se entrega: si el operador la pidió y la
   * conversación siguió veinte minutos sin pasar por un nodo de avance, ya
   * no tiene sentido cortarla de golpe.
   */
  private static readonly VIGENCIA_MS = 10 * 60_000;

  constructor(private readonly settings: SettingsService) {}

  async pedir(conversationId: string, operador: string): Promise<PeticionHandoff> {
    const peticion: PeticionHandoff = { operador, pedidoAt: new Date().toISOString() };
    await this.settings.set(clave(conversationId), peticion);
    this.logger.log(`${operador} pidió tomar la conversación en curso`);
    return peticion;
  }

  async pendiente(conversationId: string): Promise<PeticionHandoff | null> {
    const p = await this.settings.get<PeticionHandoff>(clave(conversationId));
    if (!p || p.entregadoAt) return null;
    if (Date.now() - new Date(p.pedidoAt).getTime() > HandoffService.VIGENCIA_MS) return null;
    return p;
  }

  /**
   * ¿Le toca al flujo derivar AHORA? Un solo uso: al entregarla se marca,
   * para que el flujo no quede rebotando contra el nodo de handoff en cada
   * avance posterior.
   */
  async reclamar(conversationId: string): Promise<boolean> {
    const p = await this.pendiente(conversationId);
    if (!p) return false;
    await this.settings.set(clave(conversationId), { ...p, entregadoAt: new Date().toISOString() });
    this.logger.log(`Handoff entregado al flujo (lo pidió ${p.operador})`);
    return true;
  }
}
