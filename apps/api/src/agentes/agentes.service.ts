import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Los agentes conversacionales, administrados desde la consola.
 *
 * Todo lo que el panel de ElevenLabs deja hacer a mano —crear, editar el
 * prompt, enganchar herramientas, subir contexto— pasa por su API, así que el
 * equipo puede armar un agente para una campaña sin salir de acá ni tener
 * credenciales del proveedor.
 *
 * Traduce a nuestro vocabulario a propósito: adentro es `conversation_config.
 * agent.prompt.prompt`, afuera es "instrucciones". La consola no debería saber
 * cómo se llama un campo en el proveedor de turno.
 */

/** Un agente, como lo ve la consola. */
export interface AgenteResumen {
  id: string;
  nombre: string;
  idioma: string;
  /** Con esto encendido no puede atender llamadas: solo texto. */
  soloTexto: boolean;
  herramientas: string[];
  documentos: number;
  /** Es el que atiende WhatsApp hoy: no se puede borrar sin romper producción. */
  enUso: boolean;
}

export interface AgenteDetalle extends AgenteResumen {
  instrucciones: string;
  primerMensaje: string;
  variables: string[];
}

/** Una herramienta del catálogo de la cuenta. */
export interface HerramientaDisponible {
  id: string;
  nombre: string;
  descripcion: string;
  /** `client` la ejecuta nuestra app; `webhook` la ejecuta el proveedor. */
  tipo: string;
  /** La usa el motor de la Línea 100: desengancharla rompe el flujo. */
  esencial: boolean;
}

@Injectable()
export class AgentesService {
  private readonly logger = new Logger(AgentesService.name);
  private readonly apiKey: string;
  private readonly apiUrl: string;
  /** El agente de producción, para marcarlo y protegerlo. */
  private readonly enUsoId: string;

  /**
   * Las que ejecuta AgenteToolsService. Se marcan en la consola para que nadie
   * las desenganche por error: sin ellas el agente conversa pero no hace nada.
   */
  private static readonly ESENCIALES = new Set([
    'registrar_reporte',
    'avisar_autoridad',
    'asignar_tarea',
    'escalar_a_humano',
    'actualizar_ficha',
  ]);

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    this.apiUrl = config.get<string>('ELEVENLABS_API_URL', 'https://api.elevenlabs.io');
    this.enUsoId = config.get<string>('ELEVENLABS_AGENT_ID', '');
  }

  get configurado(): boolean {
    return !!this.apiKey;
  }

  private async pedir<T>(ruta: string, cuerpo?: unknown, metodo?: string): Promise<T> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('Falta ELEVENLABS_API_KEY en el entorno.');
    }
    const res = await fetch(this.apiUrl + ruta, {
      method: metodo ?? (cuerpo === undefined ? 'GET' : 'POST'),
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 300);
      this.logger.warn(`ElevenLabs ${res.status} en ${ruta}: ${detalle}`);
      throw new ServiceUnavailableException(`El proveedor respondió ${res.status}: ${detalle}`);
    }
    // DELETE devuelve cuerpo vacío.
    const texto = await res.text();
    return (texto ? JSON.parse(texto) : {}) as T;
  }

  async listar(): Promise<AgenteResumen[]> {
    const res = await this.pedir<{ agents?: Array<{ agent_id: string; name?: string }> }>(
      '/v1/convai/agents?page_size=100',
    );
    /*
     * El listado no trae la configuración, así que se lee cada agente. Son
     * pocos —una cuenta tiene un puñado, no miles— y sin esto la lista no
     * podría decir si un agente atiende llamadas o qué herramientas tiene,
     * que es lo único que distingue a uno de otro de un vistazo.
     */
    const detalles = await Promise.all(
      (res.agents ?? []).map((a) => this.leer(a.agent_id).catch(() => null)),
    );
    return detalles.filter(Boolean) as AgenteResumen[];
  }

  async detalle(id: string): Promise<AgenteDetalle> {
    return this.leer(id);
  }

  private async leer(id: string): Promise<AgenteDetalle> {
    const a = await this.pedir<Record<string, any>>(`/v1/convai/agents/${id}`);
    const cc = a['conversation_config'] ?? {};
    const agente = cc['agent'] ?? {};
    const prompt = agente['prompt'] ?? {};

    // Los ids de herramienta no le dicen nada a nadie: se cambian por nombres.
    const catalogo = await this.catalogo();
    const porId = new Map(catalogo.map((h) => [h.id, h.nombre]));
    const deSistema = Object.entries(prompt['built_in_tools'] ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);

    return {
      id,
      nombre: a['name'] ?? 'Sin nombre',
      idioma: agente['language'] ?? 'es',
      soloTexto: !!(cc['conversation'] ?? {})['text_only'],
      herramientas: [
        ...(prompt['tool_ids'] ?? []).map((t: string) => porId.get(t) ?? 'herramienta desconocida'),
        ...deSistema,
      ],
      documentos: (prompt['knowledge_base'] ?? []).length,
      enUso: id === this.enUsoId,
      instrucciones: prompt['prompt'] ?? '',
      primerMensaje: agente['first_message'] ?? '',
      variables: Object.keys((agente['dynamic_variables'] ?? {})['dynamic_variable_placeholders'] ?? {}),
    };
  }

  /** Herramientas de la cuenta, para elegir cuáles engancha cada agente. */
  async catalogo(): Promise<HerramientaDisponible[]> {
    const res = await this.pedir<{
      tools?: Array<{ id: string; tool_config?: { name?: string; description?: string; type?: string } }>;
    }>('/v1/convai/tools?page_size=100');

    return (res.tools ?? []).map((t) => ({
      id: t.id,
      nombre: t.tool_config?.name ?? 'sin nombre',
      descripcion: t.tool_config?.description ?? '',
      tipo: t.tool_config?.type ?? 'client',
      esencial: AgentesService.ESENCIALES.has(t.tool_config?.name ?? ''),
    }));
  }

  /**
   * Motor de voz para agentes que no hablan inglés.
   *
   * No es una preferencia: crear un agente en español sin esto lo rechaza la
   * API con "Non-english Agents must use turbo or flash v2_5". El valor por
   * defecto del proveedor solo sirve en inglés.
   */
  private static readonly VOZ_MULTILINGUE = 'eleven_flash_v2_5';

  async crear(input: { nombre: string; instrucciones: string; idioma?: string }): Promise<{ id: string }> {
    const res = await this.pedir<{ agent_id: string }>('/v1/convai/agents/create', {
      name: input.nombre,
      conversation_config: {
        agent: {
          language: input.idioma ?? 'es',
          prompt: { prompt: input.instrucciones },
          // Vacío a propósito: en un chat habla primero la persona, y un saludo
          // automático llega antes de que escriba.
          first_message: '',
        },
        tts: { model_id: AgentesService.VOZ_MULTILINGUE },
      },
    });
    this.logger.log(`Agente creado: ${input.nombre}`);
    return { id: res.agent_id };
  }

  /**
   * Guarda los cambios del editor.
   *
   * Lee el agente entero y devuelve el objeto completo: la API documenta el
   * PATCH como parcial pero no dice hasta qué profundidad mezcla, y si
   * reemplazara `prompt` entero, mandar solo las herramientas borraría las
   * instrucciones. Leer primero cuesta una llamada y quita la duda.
   */
  async actualizar(
    id: string,
    cambios: {
      nombre?: string;
      instrucciones?: string;
      idioma?: string;
      primerMensaje?: string;
      soloTexto?: boolean;
      /** Nombres, no ids: la consola nunca ve un id de herramienta. */
      herramientas?: string[];
    },
  ): Promise<void> {
    const a = await this.pedir<Record<string, any>>(`/v1/convai/agents/${id}`);
    const cc = a['conversation_config'] ?? {};
    cc['agent'] = cc['agent'] ?? {};
    cc['agent']['prompt'] = cc['agent']['prompt'] ?? {};

    if (cambios.instrucciones !== undefined) cc['agent']['prompt']['prompt'] = cambios.instrucciones;
    if (cambios.idioma !== undefined) cc['agent']['language'] = cambios.idioma;
    if (cambios.primerMensaje !== undefined) cc['agent']['first_message'] = cambios.primerMensaje;
    if (cambios.soloTexto !== undefined) {
      cc['conversation'] = { ...(cc['conversation'] ?? {}), text_only: cambios.soloTexto };
    }
    if (cambios.herramientas) {
      const catalogo = await this.catalogo();
      const porNombre = new Map(catalogo.map((h) => [h.nombre, h.id]));
      cc['agent']['prompt']['tool_ids'] = cambios.herramientas
        .map((n) => porNombre.get(n))
        .filter(Boolean) as string[];
    }

    /*
     * El arreglo viejo `tools` no puede convivir con `tool_ids`: la API
     * rechaza el PATCH con "Cannot specify both". Se borra siempre, porque las
     * de sistema viven aparte en `built_in_tools` y no se pierden.
     */
    delete cc['agent']['prompt']['tools'];
    delete cc['agent']['tools'];

    await this.pedir(
      `/v1/convai/agents/${id}`,
      { conversation_config: cc, ...(cambios.nombre ? { name: cambios.nombre } : {}) },
      'PATCH',
    );
    this.logger.log(`Agente actualizado: ${cambios.nombre ?? id}`);
  }

  async duplicar(id: string, nombre: string): Promise<{ id: string }> {
    const res = await this.pedir<{ agent_id: string }>(`/v1/convai/agents/${id}/duplicate`, { name: nombre });
    return { id: res.agent_id };
  }

  /**
   * Borra un agente. El de producción NO: desengancharlo dejaría la Línea 100
   * sin quién conteste, y eso no se deshace con un ctrl-z.
   */
  async eliminar(id: string): Promise<void> {
    if (id === this.enUsoId) {
      throw new ServiceUnavailableException(
        'Ese agente es el que atiende WhatsApp ahora mismo. Cambiá el agente en uso antes de borrarlo.',
      );
    }
    await this.pedir(`/v1/convai/agents/${id}`, undefined, 'DELETE');
    this.logger.warn(`Agente eliminado: ${id}`);
  }

  /** Contexto que el agente puede consultar, escrito a mano. */
  async agregarContexto(id: string, titulo: string, texto: string): Promise<void> {
    const doc = await this.pedir<{ id: string }>('/v1/convai/knowledge-base/text', {
      name: titulo,
      text: texto,
    });

    // Subirlo no lo engancha: hay que sumarlo a la base del agente.
    const a = await this.pedir<Record<string, any>>(`/v1/convai/agents/${id}`);
    const cc = a['conversation_config'];
    const prompt = cc['agent']['prompt'];
    prompt['knowledge_base'] = [
      ...(prompt['knowledge_base'] ?? []),
      { type: 'text', name: titulo, id: doc.id, usage_mode: 'auto' },
    ];
    delete prompt['tools'];
    delete cc['agent']['tools'];

    await this.pedir(`/v1/convai/agents/${id}`, { conversation_config: cc }, 'PATCH');
    this.logger.log(`Contexto "${titulo}" agregado a ${id}`);
  }
}
