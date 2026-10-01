import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from './settings.service';

/**
 * Qué agente atiende, decidido desde la consola y no desde el entorno.
 *
 * Antes esto era `ELEVENLABS_AGENT_ID`, una variable de Vercel: cambiar de
 * agente pedía entrar al panel del proveedor de hosting, editarla y esperar un
 * despliegue. Para una municipalidad que quiere probar un agente nuevo un
 * martes a la tarde, eso no es una opción — y el que tiene la clave de Vercel
 * no es el que sabe qué agente debería atender.
 *
 * La variable de entorno queda como PISO: si nadie eligió nada en la consola,
 * sigue atendiendo el de siempre. Así un despliegue limpio o una base vacía no
 * dejan la línea sin quién conteste.
 */

/** Dónde quedó decidido quién atiende. */
export type OrigenAgente = 'consola' | 'entorno';

/** Una razón para dudar antes de cambiar de agente. */
export interface ReparoAgente {
  /** `bloqueo` impide el cambio; `aviso` solo advierte y se puede seguir. */
  gravedad: 'bloqueo' | 'aviso';
  texto: string;
}

export const CLAVE_ACTIVO = 'agente:activo';

@Injectable()
export class AgenteActivoService {
  private readonly logger = new Logger(AgenteActivoService.name);
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly delEntorno: string;
  private readonly vozDelEntorno: string;

  constructor(
    private readonly settings: SettingsService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    this.apiUrl = config.get<string>('ELEVENLABS_API_URL', 'https://api.elevenlabs.io');
    this.delEntorno = config.get<string>('ELEVENLABS_AGENT_ID', '');
    this.vozDelEntorno = config.get<string>('ELEVENLABS_VOICE_AGENT_ID', '');
  }

  /** El que atiende ahora mismo. */
  async id(): Promise<string> {
    const elegido = await this.settings.get<string>(CLAVE_ACTIVO).catch(() => undefined);
    return elegido || this.delEntorno;
  }

  /**
   * El que atiende las LLAMADAS.
   *
   * Hay un segundo id en el entorno porque el agente de WhatsApp lleva «solo
   * texto» encendido y esa opción le apaga el motor de voz: la llamada no
   * levanta. Por eso la voz podía apuntar a un gemelo sin esa opción.
   *
   * Pero si alguien eligió un agente desde la consola, ese manda para todo: lo
   * que se pidió fue «que pase a ser el que atiende las conversaciones y las
   * llamadas», y un cambio que mueve una mitad y deja la otra donde estaba es
   * justo el estado partido que no se nota.
   */
  async idVoz(): Promise<string> {
    const elegido = await this.settings.get<string>(CLAVE_ACTIVO).catch(() => undefined);
    return elegido || this.vozDelEntorno || this.delEntorno;
  }

  async origen(): Promise<OrigenAgente> {
    const elegido = await this.settings.get<string>(CLAVE_ACTIVO).catch(() => undefined);
    return elegido ? 'consola' : 'entorno';
  }

  /**
   * Hay ALGÚN agente configurado.
   *
   * Síncrono y mirando solo el entorno a propósito: lo usan los chequeos de
   * "¿está el motor encendido?", que corren antes de cualquier await y en
   * caminos donde no se puede ir a la base. Si alguien eligió un agente desde
   * la consola sin que haya variable de entorno, esto dice que no hay nada
   * configurado y la pantalla de integraciones lo muestra como pendiente; el
   * agente igual atiende, porque quien atiende se resuelve con `id()`.
   */
  get hayAlguno(): boolean {
    return !!this.delEntorno;
  }

  /**
   * Pone a este agente a atender: WhatsApp, llamadas salientes y entrantes.
   *
   * Reasignar el NÚMERO es parte del cambio y no un extra. Nuestra
   * configuración decide a quién le hablamos nosotros —WhatsApp y las llamadas
   * que salen—, pero las llamadas que ENTRAN las enruta el proveedor según a
   * qué agente está asignado el número. Sin esta parte, cambiar de agente
   * dejaba un estado partido: los mensajes los contestaba el nuevo y el
   * teléfono seguía cayendo en el viejo, que es exactamente la clase de cosa
   * que nadie nota hasta que un vecino cuenta algo raro.
   */
  async poner(id: string): Promise<{ numeros: string[]; aviso?: string }> {
    await this.settings.set(CLAVE_ACTIVO, id);
    this.logger.warn(`El agente que atiende pasó a ser ${id}`);

    try {
      const numeros = await this.reasignarNumeros(id);
      return { numeros };
    } catch (err) {
      // El cambio YA está hecho: que falle el número no lo deshace, pero hay
      // que decirlo o el teléfono queda cayendo en el agente viejo en silencio.
      const motivo = (err as Error).message;
      this.logger.warn(`No se pudieron reasignar los números: ${motivo}`);
      return {
        numeros: [],
        aviso: `El agente ya contesta los mensajes, pero no se pudo mover el teléfono: ${motivo}. Las llamadas entrantes siguen yendo al agente anterior.`,
      };
    }
  }

  /** Mueve al agente nuevo los números que tenía el anterior. */
  private async reasignarNumeros(id: string): Promise<string[]> {
    const numeros = await this.pedir<
      Array<{ phone_number_id: string; phone_number: string; assigned_agent?: { agent_id?: string } }>
    >('/v1/convai/phone-numbers');

    const movidos: string[] = [];
    for (const n of numeros ?? []) {
      if (n.assigned_agent?.agent_id === id) continue;
      await this.pedir(`/v1/convai/phone-numbers/${n.phone_number_id}`, { agent_id: id }, 'PATCH');
      movidos.push(n.phone_number);
    }
    return movidos;
  }

  /**
   * Qué puede salir mal con este agente, antes de ponerlo a atender.
   *
   * Existe porque el error acá no avisa. Un agente en inglés, o sin
   * herramientas, o con "solo texto" encendido, no tira ninguna excepción: se
   * pone a atender y contesta. La diferencia aparece del lado del vecino, en
   * una llamada que ya pasó.
   */
  async revisar(id: string): Promise<ReparoAgente[]> {
    let a: Record<string, any>;
    try {
      a = await this.pedir<Record<string, any>>(`/v1/convai/agents/${id}`);
    } catch {
      return [{ gravedad: 'bloqueo', texto: 'Ese agente ya no existe en la cuenta.' }];
    }

    const cc = a['conversation_config'] ?? {};
    const agente = cc['agent'] ?? {};
    const prompt = agente['prompt'] ?? {};
    const reparos: ReparoAgente[] = [];

    if (cc['conversation']?.['text_only']) {
      reparos.push({
        gravedad: 'aviso',
        texto:
          'Tiene «solo texto» encendido, y eso le apaga el motor de voz: va a contestar WhatsApp pero las llamadas no van a levantar.',
      });
    }

    const idioma = agente['language'] ?? 'es';
    if (idioma !== 'es') {
      reparos.push({
        gravedad: 'aviso',
        texto: `Está configurado en «${idioma}», no en español. Le va a contestar en ese idioma a quien llame.`,
      });
    }

    /*
     * Sin NINGUNA herramienta, no sin "las de la Línea 100".
     *
     * Esta consola lleva agentes con trabajos distintos —el de la Línea 100
     * abre reportes; Movi contesta sobre beneficios de una cooperativa— y
     * cuáles herramientas le corresponden a cada uno lo decide su función,
     * no nosotros. Lo único que es un problema en CUALQUIER agente es no
     * tener ninguna: conversa amable, suena bien en la transcripción y no
     * ejecuta nada, que es el peor modo de fallar porque nada se rompe.
     */
    if (!(prompt['tool_ids'] ?? []).length) {
      reparos.push({
        gravedad: 'aviso',
        texto:
          'No tiene ninguna herramienta enganchada: puede conversar, pero no puede HACER nada (registrar, avisar, escalar). Si su trabajo es solo informar, está bien así.',
      });
    }

    /*
     * Sin saludo, una llamada arranca en silencio: el vecino atiende, no
     * escucha nada y cuelga. Ya pasó, y el síntoma —"la llamada se corta
     * sola"— no dice nada del saludo. El agente de WhatsApp puede tenerlo
     * vacío a propósito (en un chat habla primero la persona), por eso es
     * aviso y no bloqueo.
     */
    if (!(agente['first_message'] ?? '').trim() && !cc['conversation']?.['text_only']) {
      reparos.push({
        gravedad: 'aviso',
        texto: 'No tiene saludo: una llamada arranca en silencio y quien atiende suele colgar.',
      });
    }

    if (!(prompt['prompt'] ?? '').trim()) {
      reparos.push({ gravedad: 'bloqueo', texto: 'No tiene instrucciones: no sabría qué contestar.' });
    }

    return reparos;
  }

  /**
   * Qué hilos son del agente activo, para que el tablero y la bandeja sigan
   * al selector.
   *
   * La marca `agente` no dice "este mensaje lo escribió el agente": dice EN
   * QUÉ ESPACIO ocurrió — todo lo que el sistema escribe (la pregunta del
   * vecino, la respuesta, la nota del operador) la lleva. Por eso la regla es
   * por hilo y simple:
   *
   * - alguna interacción marcada con este agente → suyo (si lo atendieron
   *   dos en épocas distintas, se ve desde los dos: el hilo es del contacto);
   * - tiene historia pero NINGUNA marca → del agente del entorno. Es todo lo
   *   anterior a la atribución —la era NL Pearl marcaba `handledBy` con el
   *   nombre del Pearl, los mensajes sin respuesta no marcaban nada— y toda
   *   esa historia la atendió la Línea 100. La primera versión de esta regla
   *   miraba `handledBy === 'agente'` y esos hilos se colaban en CUALQUIER
   *   agente: cambiar a Movi mostraba la bandeja de la Línea 100 igual;
   * - sin interacciones → se ve desde cualquiera: un contacto recién creado
   *   tiene que verse, o no hay desde dónde escribirle.
   */
  // `handledBy` se acepta pero NO se consulta, a propósito: trae nombres de
  // Pearl, de operadores o 'agente' según la época, y decidir con eso fue el
  // bug que coló la bandeja de la Línea 100 dentro de la de Movi.
  async filtroDeHilos(): Promise<
    (interacciones: Array<{ agente?: string; handledBy?: string }>) => boolean
  > {
    const activo = await this.id();

    return (interacciones) => {
      if (!interacciones.length) return true;
      if (interacciones.some((i) => i.agente === activo)) return true;
      /*
       * La historia sin marca es del agente del entorno ADEMÁS de lo que el
       * hilo tenga marcado: un hilo viejo de la Línea 100 que después atendió
       * Movi es de los dos, y la primera versión de esta línea lo hacía
       * desaparecer de la bandeja de la Línea 100 al primer mensaje de Movi.
       */
      const haySinMarca = interacciones.some((i) => !i.agente);
      return haySinMarca && activo === this.delEntorno;
    };
  }

  private async pedir<T>(ruta: string, cuerpo?: unknown, metodo?: string): Promise<T> {
    const res = await fetch(this.apiUrl + ruta, {
      method: metodo ?? (cuerpo === undefined ? 'GET' : 'POST'),
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const texto = await res.text();
    return (texto ? JSON.parse(texto) : {}) as T;
  }
}
