import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentesService, AristaFlujo, NodoFlujo } from './agentes.service';

const MODELO = 'claude-opus-4-8';

/** Un turno del chat del asistente, como lo manda y lo lee la consola. */
export interface TurnoAsistente {
  de: 'persona' | 'asistente';
  texto: string;
}

/** Lo que el asistente hizo de verdad en este turno. */
export interface CambioAsistente {
  accion: 'crear' | 'instrucciones' | 'herramientas' | 'flujo';
  detalle: string;
}

const INSTRUCCIONES = [
  'Sos el asistente que arma agentes conversacionales para la Línea 100 de la AMDC',
  '(Tegucigalpa, Honduras), desde la consola de Movitext.',
  '',
  'Tu trabajo es que quien te habla —un operador municipal, no un programador—',
  'termine con un agente ARMADO: creado, con sus herramientas y con su flujo.',
  '',
  'Cómo trabajás:',
  '- Hablás en español de Centroamérica, con voseo. Frases cortas.',
  '- Preguntá de a UNA cosa. Nadie contesta un cuestionario de seis puntos.',
  '- Apenas sepas para qué es el agente, CREALO con `crear_agente` y seguí',
  '  afinándolo. Es mejor tener algo que mirar que seguir preguntando a ciegas.',
  '- No pidas permiso para cada cambio: hacelo y contá qué hiciste.',
  '- Nunca menciones ids, hashes ni nombres técnicos del proveedor.',
  '',
  'Sobre el flujo:',
  '- Un flujo son FASES (momentos de la conversación) unidas por condiciones en',
  '  lenguaje natural. Siempre empieza en la fase de inicio.',
  '- El orden de las salidas importa: gana la primera condición que se cumple,',
  '  así que lo urgente ("hay alguien en peligro") va antes que lo general.',
  '- No armes un flujo de veinte nodos. Cuatro o cinco fases bien puestas es un',
  '  flujo que alguien puede mantener.',
  '',
  'Sobre las herramientas: engancha solo las que el agente de verdad va a usar.',
  'Una herramienta de más es una acción que puede disparar sin querer.',
].join('\n');

/** Las herramientas que el asistente puede usar sobre el agente real. */
const HERRAMIENTAS: Anthropic.Tool[] = [
  {
    name: 'crear_agente',
    description:
      'Crea el agente de verdad. Llamala apenas sepas para qué es; después se puede seguir afinando.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Corto y reconocible para el equipo.' },
        instrucciones: {
          type: 'string',
          description: 'El prompt base: quién es, qué hace, qué no hace y cómo habla.',
        },
      },
      required: ['nombre', 'instrucciones'],
    },
  },
  {
    name: 'ajustar_agente',
    description: 'Cambia el nombre, las instrucciones o el primer mensaje del agente ya creado.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        instrucciones: { type: 'string' },
        primerMensaje: { type: 'string' },
      },
    },
  },
  {
    name: 'elegir_herramientas',
    description:
      'Define qué puede HACER el agente. Se manda la lista completa: lo que no esté, queda desenganchado.',
    input_schema: {
      type: 'object',
      properties: {
        herramientas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nombres del catálogo, tal cual figuran.',
        },
      },
      required: ['herramientas'],
    },
  },
  {
    name: 'definir_flujo',
    description:
      'Reemplaza el flujo entero. La primera fase es el inicio. Las condiciones van en lenguaje natural.',
    input_schema: {
      type: 'object',
      properties: {
        fases: {
          type: 'array',
          description: 'En orden: la primera es por donde entra la conversación.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Corto y sin espacios, para referenciarla.' },
              nombre: { type: 'string' },
              instrucciones: { type: 'string', description: 'Qué hace el agente mientras está acá.' },
              herramientas: { type: 'array', items: { type: 'string' } },
              fin: { type: 'boolean', description: 'true si acá termina la conversación.' },
            },
            required: ['id', 'nombre'],
          },
        },
        salidas: {
          type: 'array',
          description: 'De qué fase a qué fase, y con qué condición. El orden es el de evaluación.',
          items: {
            type: 'object',
            properties: {
              desde: { type: 'string' },
              hasta: { type: 'string' },
              condicion: { type: 'string', description: 'Vacío = pasa siempre.' },
            },
            required: ['desde', 'hasta'],
          },
        },
      },
      required: ['fases', 'salidas'],
    },
  },
];

/**
 * El asistente que arma un agente conversando.
 *
 * Existe porque crear un agente pidiendo un nombre y soltando al operador en
 * un editor vacío no es crear nada: el trabajo de verdad —qué dice, qué puede
 * hacer, por qué fases pasa— quedaba entero por delante y sin ayuda.
 *
 * Las herramientas del asistente no son de mentira: crean y modifican el
 * agente REAL contra el proveedor. Por eso el flujo se guarda con la misma
 * función que usa el editor visual, y lo que se arma acá se puede seguir
 * editando a mano ahí.
 */
@Injectable()
export class AsistenteAgentesService {
  private readonly logger = new Logger(AsistenteAgentesService.name);
  private readonly cliente: Anthropic | null;

  constructor(
    config: ConfigService,
    private readonly agentes: AgentesService,
  ) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY', '');
    this.cliente = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get configurado(): boolean {
    return !!this.cliente;
  }

  /**
   * Un turno del chat: contesta y, si corresponde, toca el agente de verdad.
   *
   * Se hace el bucle a mano en vez de usar el corredor de herramientas del SDK
   * porque cada ejecución tiene que quedar registrada para devolvérsela a la
   * consola: el lienzo de la izquierda se redibuja con eso, y sin saber QUÉ
   * cambió habría que recargar todo en cada mensaje.
   */
  async responder(
    turnos: TurnoAsistente[],
    agenteId: string | null,
  ): Promise<{ respuesta: string; agenteId: string | null; cambios: CambioAsistente[] }> {
    if (!this.cliente) {
      return {
        respuesta: 'Falta la credencial del asistente en el entorno; probá con el formulario.',
        agenteId,
        cambios: [],
      };
    }

    const catalogo = await this.agentes.catalogo().catch(() => []);
    const contexto = [
      INSTRUCCIONES,
      '',
      'Herramientas disponibles en la cuenta (usá estos nombres tal cual):',
      ...catalogo.map((h) => `- ${h.nombre}: ${h.descripcion || 'sin descripción'}`),
      '',
      agenteId
        ? 'El agente YA está creado: usá `ajustar_agente`, no `crear_agente`.'
        : 'Todavía no hay agente creado.',
    ].join('\n');

    const mensajes: Anthropic.MessageParam[] = turnos.map((t) => ({
      role: t.de === 'persona' ? 'user' : 'assistant',
      content: t.texto,
    }));

    const cambios: CambioAsistente[] = [];
    let id = agenteId;

    // Tope de vueltas: sin él, un modelo que insiste con una herramienta que
    // falla dejaría la petición girando hasta el timeout de la lambda.
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      const res = await this.cliente.messages.create({
        model: MODELO,
        max_tokens: 4000,
        system: contexto,
        tools: HERRAMIENTAS,
        messages: mensajes,
      });

      const usos = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!usos.length) {
        return { respuesta: AsistenteAgentesService.textoDe(res), agenteId: id, cambios };
      }

      mensajes.push({ role: 'assistant', content: res.content });
      const resultados: Anthropic.ToolResultBlockParam[] = [];

      for (const uso of usos) {
        const r = await this.ejecutar(uso.name, uso.input as Record<string, unknown>, id);
        if (r.id) id = r.id;
        if (r.cambio) cambios.push(r.cambio);
        resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: r.salida });
      }

      mensajes.push({ role: 'user', content: resultados });
    }

    return {
      respuesta: 'Me enredé armándolo. Contame de nuevo qué necesitás y lo retomo.',
      agenteId: id,
      cambios,
    };
  }

  private static textoDe(res: Anthropic.Message): string {
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  private async ejecutar(
    nombre: string,
    args: Record<string, unknown>,
    agenteId: string | null,
  ): Promise<{ salida: string; id?: string; cambio?: CambioAsistente }> {
    try {
      switch (nombre) {
        case 'crear_agente': {
          if (agenteId) return { salida: 'El agente ya existe; usá `ajustar_agente`.' };
          const { id } = await this.agentes.crear({
            nombre: String(args['nombre'] ?? 'Agente nuevo'),
            instrucciones: String(args['instrucciones'] ?? ''),
          });
          return {
            salida: 'Agente creado.',
            id,
            cambio: { accion: 'crear', detalle: `Se creó «${String(args['nombre'])}»` },
          };
        }

        case 'ajustar_agente': {
          if (!agenteId) return { salida: 'Todavía no hay agente: crealo primero.' };
          await this.agentes.actualizar(agenteId, {
            nombre: args['nombre'] as string | undefined,
            instrucciones: args['instrucciones'] as string | undefined,
            primerMensaje: args['primerMensaje'] as string | undefined,
          });
          return {
            salida: 'Listo.',
            cambio: { accion: 'instrucciones', detalle: 'Se afinaron las instrucciones' },
          };
        }

        case 'elegir_herramientas': {
          if (!agenteId) return { salida: 'Todavía no hay agente: crealo primero.' };
          const pedidas = (args['herramientas'] as string[] | undefined) ?? [];
          const catalogo = await this.agentes.catalogo();
          const validas = pedidas.filter((p) => catalogo.some((h) => h.nombre === p));
          const desconocidas = pedidas.filter((p) => !validas.includes(p));

          await this.agentes.actualizar(agenteId, { herramientas: validas });
          return {
            // Se devuelven las desconocidas para que el modelo no siga
            // creyendo que enganchó algo que no existe.
            salida: desconocidas.length
              ? `Enganchadas: ${validas.join(', ') || 'ninguna'}. No existen en la cuenta: ${desconocidas.join(', ')}.`
              : `Enganchadas: ${validas.join(', ') || 'ninguna'}.`,
            cambio: { accion: 'herramientas', detalle: `Herramientas: ${validas.join(', ') || 'ninguna'}` },
          };
        }

        case 'definir_flujo': {
          if (!agenteId) return { salida: 'Todavía no hay agente: crealo primero.' };
          const { nodos, aristas } = AsistenteAgentesService.aFlujo(args);
          if (!nodos.length) return { salida: 'El flujo venía vacío; no se guardó nada.' };
          await this.agentes.guardarFlujo(agenteId, { nodos, aristas });
          return {
            salida: `Flujo guardado con ${nodos.length} fase(s).`,
            cambio: { accion: 'flujo', detalle: `Flujo de ${nodos.length} fase(s)` },
          };
        }

        default:
          return { salida: `No conozco la herramienta ${nombre}.` };
      }
    } catch (err) {
      const motivo = (err as Error).message;
      this.logger.warn(`El asistente falló en ${nombre}: ${motivo}`);
      // El motivo vuelve al modelo a propósito: con "falló" a secas repite lo
      // mismo, y con el mensaje del proveedor suele corregirse solo.
      return { salida: `Falló: ${motivo}` };
    }
  }

  private static aFlujo = flujoDesdeAsistente;
}

/**
 * Del vocabulario del asistente al del editor visual.
 *
 * Las posiciones las pone la app y no el modelo: pedirle coordenadas es
 * pedirle que haga de tipógrafo, y salían nodos encimados. Se acomodan en
 * zigzag, que es como el editor las deja legibles y desde donde el operador
 * las puede arrastrar.
 */
export function flujoDesdeAsistente(
args: Record<string, unknown>,
): { nodos: NodoFlujo[]; aristas: AristaFlujo[] } {
  type Fase = {
    id?: string;
    nombre?: string;
    instrucciones?: string;
    herramientas?: string[];
    fin?: boolean;
  };
  type Salida = { desde?: string; hasta?: string; condicion?: string };

  const fases = ((args['fases'] as Fase[] | undefined) ?? []).filter((f) => f?.id && f?.nombre);
  const salidas = ((args['salidas'] as Salida[] | undefined) ?? []).filter((s) => s?.desde && s?.hasta);

  /*
   * El nodo de entrada tiene que llamarse `start_node`: es lo que exige el
   * proveedor y lo que costó una ronda de "Workflow must contain a start
   * node". El resto conserva el id que puso el asistente.
   */
  const primero = fases[0]?.id;
  const idDe = (id?: string) => (id && id === primero ? 'start_node' : (id ?? ''));

  const nodos: NodoFlujo[] = fases.map((f, i) => ({
    id: idDe(f.id),
    tipo: f.fin ? 'fin' : i === 0 ? 'inicio' : 'fase',
    nombre: f.nombre!,
    x: 140 + (i % 2) * 300,
    y: 80 + i * 190,
    instrucciones: f.instrucciones ?? '',
    herramientas: f.herramientas ?? [],
  }));

  const aristas: AristaFlujo[] = salidas.map((s, i) => ({
    id: `e${i + 1}`,
    desde: idDe(s.desde),
    hasta: idDe(s.hasta),
    condicion: s.condicion ?? '',
  }));

  // El orden de evaluación de cada fase es el orden en que llegaron sus
  // salidas: gana la primera que se cumple, así que no es cosmético.
  for (const n of nodos) {
    const suyas = aristas.filter((a) => a.desde === n.id).map((a) => a.id);
    if (suyas.length > 1) n.orden = suyas;
  }

  return { nodos, aristas };
}
