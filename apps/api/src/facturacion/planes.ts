/**
 * Los planes: lo que se cobra por tener el agente, aparte de los mensajes.
 *
 * Un plan define tres cosas distintas y conviene no confundirlas:
 *
 *  - CUÁNTO cuesta por mes (el agente trabajando, no los mensajes).
 *  - CUÁNTO cabe: agentes, usuarios y mensajes incluidos.
 *  - QUÉ se puede hacer: las funciones que el plan habilita.
 *
 * Los mensajes incluidos son una bolsa, y lo que pasa del tope se cobra por
 * unidad a la tarifa del país. Eso es lo que hace el modelo honesto: el
 * cliente chico paga poco y el que manda mucho paga por lo que manda, en vez
 * de que uno subsidie al otro.
 *
 * Esto es DATO, no código: una función nueva se agrega a la lista y la
 * pantalla la muestra sin que nadie toque un `if`.
 */

/**
 * Lo que un plan habilita. Son las puertas que el servidor revisa, no
 * etiquetas de folleto: agregar una acá obliga a decidir en qué plan entra.
 */
export type Funcion =
  | 'agente'
  | 'documentos'
  | 'flujos'
  | 'seguimiento'
  | 'cambio-agente'
  | 'tarifa-propia'
  | 'api';

export const NOMBRE_FUNCION: Record<Funcion, string> = {
  agente: 'Agente que contesta en WhatsApp',
  documentos: 'Base de conocimiento con documentos',
  flujos: 'Editor de flujo de la conversación',
  seguimiento: 'Seguimiento automático',
  'cambio-agente': 'Cambio de agente entre agentes',
  'tarifa-propia': 'Tarifa negociada por país',
  api: 'API y webhooks',
};

export interface Plan {
  id: string;
  nombre: string;
  /** Para quién es, en una línea. */
  resumen: string;
  /** Por mes, en microdólares. Cero en la prueba. */
  precioMensual: number;
  /** La bolsa de mensajes del mes. Lo que pasa se cobra por tarifa. */
  mensajesIncluidos: number;
  /** Tope de agentes. `null` = sin tope. */
  agentes: number | null;
  /** Tope de usuarios de la consola. `null` = sin tope. */
  usuarios: number | null;
  funciones: Funcion[];
  /**
   * ¿Se puede pasar de los mensajes incluidos?
   *
   * En la prueba NO: alguien que todavía no dio una tarjeta no puede
   * generar una deuda. En los planes pagos sí, con el tope de gasto que el
   * administrador fije.
   */
  permiteExceso: boolean;
  /** No se ofrece en la pantalla de planes (es nuestro, o es a medida). */
  oculto?: boolean;
}

const PLANES: Plan[] = [
  {
    id: 'prueba',
    nombre: 'Prueba',
    resumen: 'Para ver si el agente sirve en tu negocio, sin pagar nada.',
    precioMensual: 0,
    mensajesIncluidos: 200,
    agentes: 1,
    usuarios: 2,
    funciones: ['agente', 'documentos'],
    permiteExceso: false,
  },
  {
    id: 'negocio',
    nombre: 'Negocio',
    resumen: 'Un negocio con un número y varias personas atendiendo.',
    precioMensual: 49_000_000,
    mensajesIncluidos: 3_000,
    agentes: 3,
    usuarios: 10,
    funciones: ['agente', 'documentos', 'flujos', 'seguimiento'],
    permiteExceso: true,
  },
  {
    id: 'institucional',
    nombre: 'Institucional',
    resumen: 'Varias áreas, varios números y agentes que se pasan el caso.',
    precioMensual: 149_000_000,
    mensajesIncluidos: 15_000,
    agentes: null,
    usuarios: null,
    funciones: ['agente', 'documentos', 'flujos', 'seguimiento', 'cambio-agente', 'tarifa-propia', 'api'],
    permiteExceso: true,
  },
  {
    /*
     * El nuestro. Existe porque la organización histórica (Movitext) opera
     * la Línea 100 y no se le factura: sin este plan, el primer tope de
     * mensajes dejaría muda una línea que atiende emergencias de verdad.
     */
    id: 'interno',
    nombre: 'Interno',
    resumen: 'Movitext. Sin topes y sin factura.',
    precioMensual: 0,
    mensajesIncluidos: Number.MAX_SAFE_INTEGER,
    agentes: null,
    usuarios: null,
    funciones: ['agente', 'documentos', 'flujos', 'seguimiento', 'cambio-agente', 'tarifa-propia', 'api'],
    permiteExceso: true,
    oculto: true,
  },
];

/** El plan por su id. Un id desconocido cae en la prueba: lo más restrictivo. */
export function plan(id?: string): Plan {
  return PLANES.find((p) => p.id === id) ?? PLANES[0];
}

/** Los que se ofrecen en la pantalla de planes. */
export function planesVisibles(): Plan[] {
  return PLANES.filter((p) => !p.oculto);
}

export function planes(): Plan[] {
  return PLANES;
}

/**
 * ¿Este plan habilita esta función?
 *
 * Se pregunta en el SERVIDOR antes de hacer el trabajo. Una función que
 * solo se esconde en la pantalla está disponible para cualquiera que sepa
 * escribir la petición a mano.
 */
export function habilita(idPlan: string | undefined, funcion: Funcion): boolean {
  return plan(idPlan).funciones.includes(funcion);
}
