import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { NlpearlActivityStore } from './activity.store';

/**
 * Resumen corto de una conversación, redactado por nosotros.
 *
 * Por qué existe: el `post_call_summary` que devuelve NL Pearl viene largo,
 * en inglés y en primera persona del agente ("I collected his details…"). Eso
 * no es un resumen para el operador de la Línea 100: es la bitácora del bot.
 * Acá se genera uno corto, en español, en tercera persona y centrado en lo
 * que el operador necesita decidir.
 *
 * El resultado se CACHEA en el almacén de actividad con la huella de la
 * transcripción. La vista del hilo se sondea cada pocos segundos; sin caché
 * cada vuelta sería una llamada al modelo.
 */

const MODELO = 'claude-opus-4-8';

const INSTRUCCIONES = [
  'Sos el asistente de la consola de la Línea 100 de la AMDC (Tegucigalpa, Honduras).',
  'Resumí la conversación para el operador municipal que la va a atender.',
  '',
  'Reglas:',
  '- UNA sola oración. Máximo 25 palabras. Es un titular, no un párrafo.',
  '- Español de Centroamérica, en tercera persona. Nunca en primera persona del agente.',
  '- Empezá por el problema. Nada de saludos, ni del procedimiento del bot, ni de que se registró el reporte.',
  '- Incluí el lugar si está. Omití todo lo demás antes que pasarte de largo.',
  '- No repitas el nombre ni el teléfono: ya se muestran en la ficha de al lado.',
  '- Si no se llegó a nada concreto, decilo en pocas palabras.',
  '- Devolvé SOLO la oración, sin encabezados, sin comillas y sin viñetas.',
  '',
  'Ejemplos del largo esperado:',
  'Fuga de agua por tubería rota en Calle Palermo, Tegucigalpa, desde hace dos horas.',
  'Hundimiento grande bloquea el paso en la primera entrada de la colonia Kennedy.',
  'Vehículo abandonado sobre la acera frente a la Escuela Policarpo, colonia Villa Nueva.',
].join('\n');

/** Tope duro: si el modelo se pasa igual, se recorta antes de mostrarlo. */
const TOPE = 160;

@Injectable()
export class ResumenService {
  private readonly logger = new Logger(ResumenService.name);
  private readonly cliente: Anthropic | null;

  constructor(
    config: ConfigService,
    private readonly store: NlpearlActivityStore,
  ) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY', '');
    this.cliente = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get configured(): boolean {
    return !!this.cliente;
  }

  /** Huella del texto: si la conversación no cambió, no se vuelve a resumir. */
  private static huella(texto: string): string {
    return createHash('sha256').update(texto).digest('hex').slice(0, 16);
  }

  /** Primera oración, y si aun así se pasa del tope, se corta por palabra. */
  private static aUnaOracion(texto: string): string {
    const limpio = texto.replace(/\s+/g, ' ').trim().replace(/^["“']|["”']$/g, '');
    const primera = limpio.match(/^[^.!?]+[.!?]/)?.[0]?.trim() ?? limpio;
    if (primera.length <= TOPE) return primera;
    const corte = primera.slice(0, TOPE);
    return `${corte.slice(0, corte.lastIndexOf(' ') || TOPE)}…`;
  }

  /**
   * Devuelve el resumen corto de esa transcripción, generándolo solo si no
   * hay uno cacheado para su huella. Nunca lanza: si el modelo no está
   * configurado o falla, devuelve null y el llamador cae a su respaldo.
   */
  async corto(transcripcion: string, phone?: string): Promise<string | null> {
    const texto = transcripcion.trim();
    // Una transcripción de dos líneas no necesita resumen: ya es corta.
    if (texto.length < 160) return null;

    const huella = ResumenService.huella(texto);
    /*
     * La versión va en la clave a propósito: la caché es por huella de la
     * transcripción, así que sin esto un cambio de instrucciones seguiría
     * sirviendo los resúmenes redactados con las viejas. Subila cuando
     * cambien INSTRUCCIONES o el tope.
     */
    const id = `resumen:v2:${huella}`;

    const cacheado = await this.leerCache(id);
    if (cacheado) return cacheado;

    if (!this.cliente) return null;

    try {
      const res = await this.cliente.messages.create({
        model: MODELO,
        max_tokens: 300,
        system: INSTRUCCIONES,
        messages: [{ role: 'user', content: `Conversación:\n\n${texto.slice(0, 12000)}` }],
      });

      const crudo = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();

      // El prompt pide una oración, pero el tope no se deja a su criterio:
      // esta tarjeta vive en una columna angosta al lado de la ficha.
      const salida = ResumenService.aUnaOracion(crudo);
      if (!salida) return null;

      await this.store.recordActivity({
        id,
        phone,
        kind: 'resumen',
        occurredAt: new Date().toISOString(),
        raw: { texto: salida, modelo: MODELO, huella },
      });
      return salida;
    } catch (err) {
      // Que falte la clave o se caiga el modelo no puede tumbar el expediente.
      this.logger.warn(`No se pudo redactar el resumen: ${(err as Error).message}`);
      return null;
    }
  }

  private async leerCache(id: string): Promise<string | null> {
    try {
      const fila = await this.store.findActivity(id);
      const texto = (fila?.raw as { texto?: string } | undefined)?.texto;
      return typeof texto === 'string' && texto.trim() ? texto.trim() : null;
    } catch {
      return null;
    }
  }
}
