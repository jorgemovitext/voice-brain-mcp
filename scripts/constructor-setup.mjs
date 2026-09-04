/*
 * Provisiona el agente CONSTRUCTOR: el que arma otros agentes conversando.
 *
 * Va sobre ElevenLabs y no sobre otro proveedor para no sumar una credencial
 * ni otra factura: la cuenta ya está pagada y el cliente de la app ya sabe
 * hablarle a cualquier agente en modo texto y ejecutarle herramientas.
 *
 * Las herramientas son TODAS de argumentos planos —strings— y el flujo se arma
 * fase por fase en vez de mandarlo entero en un solo objeto anidado. No es
 * capricho: estos agentes están afinados para contestar por teléfono en dos
 * líneas, y pedirles un arreglo de objetos en una sola respuesta es donde
 * fallan — y cuando fallan no fallan claro, mandan la mitad. De a una fase,
 * cada llamada es una frase corta y el lienzo se dibuja mientras avanza.
 *
 *   node scripts/constructor-setup.mjs
 */
import 'dotenv/config';

const API = process.env.ELEVENLABS_API_URL ?? 'https://api.elevenlabs.io';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('Falta ELEVENLABS_API_KEY.');
  process.exit(1);
}

/** Motor de voz obligatorio para agentes que no hablan inglés. */
const VOZ_MULTILINGUE = 'eleven_flash_v2_5';
const NOMBRE = 'Constructor de agentes';

const INSTRUCCIONES = [
  'Sos el constructor de agentes de la consola de Movitext, para la Línea 100',
  'de la AMDC (Tegucigalpa, Honduras).',
  '',
  'Quien te habla es un operador municipal, no un programador. Tu trabajo es',
  'que termine con un agente ARMADO: creado, con herramientas y con su flujo.',
  '',
  'Cómo trabajás:',
  '- Español de Centroamérica, con voseo. Frases cortas.',
  '- Preguntá de a UNA cosa. Nadie contesta un cuestionario de seis puntos.',
  '- Apenas sepas para qué es, llamá a crear_agente y seguí afinándolo. Es',
  '  mejor tener algo que mirar que seguir preguntando a ciegas.',
  '- No pidas permiso para cada cambio: hacelo y contá qué hiciste.',
  '- Nunca menciones ids ni nombres técnicos del proveedor.',
  '',
  'El flujo se arma DE A UNA FASE: llamás agregar_fase por cada momento de la',
  'conversación y después conectar_fases por cada salida. La primera fase que',
  'agregues es por donde entra la conversación.',
  '',
  'El orden en que conectás importa: gana la primera condición que se cumple,',
  'así que conectá primero lo urgente ("hay alguien en peligro") y después lo',
  'general ("quiere reportar algo").',
  '',
  'Cuatro o cinco fases bien puestas es un flujo que alguien puede mantener.',
  'Veinte no lo mantiene nadie.',
].join('\n');

/*
 * Todo string, y las listas separadas por comas: un enum o un arreglo anidado
 * es justo lo que este motor emite mal.
 */
const HERRAMIENTAS = [
  {
    name: 'crear_agente',
    description:
      'Crea el agente de verdad. Llamala apenas sepas para qué es; después se sigue afinando.',
    props: {
      nombre: ['Corto y reconocible para el equipo', true],
      instrucciones: ['Quién es, qué hace, qué no hace y cómo habla', true],
    },
  },
  {
    name: 'ajustar_agente',
    description: 'Cambia el nombre, las instrucciones o el saludo del agente ya creado.',
    props: {
      nombre: ['Dejalo vacío si no cambia', false],
      instrucciones: ['Dejalo vacío si no cambian', false],
      primer_mensaje: ['El saludo. Vacío si no cambia', false],
    },
  },
  {
    name: 'elegir_herramientas',
    description:
      'Define qué puede HACER el agente. Mandá la lista COMPLETA separada por comas: ' +
      'lo que no esté queda desenganchado.',
    props: {
      herramientas: ['Nombres del catálogo separados por comas', true],
    },
  },
  {
    name: 'agregar_fase',
    description:
      'Agrega un momento de la conversación al flujo. La PRIMERA que agregues es la entrada.',
    props: {
      id: ['Corto, sin espacios ni acentos, para conectarla después', true],
      nombre: ['Cómo se llama la fase en el dibujo', true],
      instrucciones: ['Qué hace el agente mientras está en esta fase', false],
      herramientas: ['Las que puede usar acá, separadas por comas', false],
      es_fin: ['Poné "si" si acá termina la conversación', false],
    },
  },
  {
    name: 'conectar_fases',
    description:
      'Conecta dos fases. Conectá primero lo urgente: gana la primera condición que se cumple.',
    props: {
      desde: ['Id de la fase de la que sale', true],
      hasta: ['Id de la fase a la que llega', true],
      condicion: ['En lenguaje natural. Vacío = pasa siempre', false],
    },
  },
];

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status}\n${texto.slice(0, 600)}`);
  return texto ? JSON.parse(texto) : {};
}

function configDe(h) {
  const properties = {};
  const required = [];
  for (const [nombre, [descripcion, obligatorio]] of Object.entries(h.props)) {
    properties[nombre] = { type: 'string', description: descripcion };
    if (obligatorio) required.push(nombre);
  }
  return {
    type: 'client',
    name: h.name,
    description: h.description,
    parameters: { type: 'object', properties, required },
    // Espera respuesta: le devolvemos si se creó, o el motivo del fallo, y con
    // eso suele corregirse solo. Sin esperar, seguiría hablando como si hubiera
    // salido bien.
    expects_response: true,
    response_timeout_secs: 30,
  };
}

// --- 1. las herramientas, idempotente -----------------------------------------

console.log('Herramientas del constructor');
const existentes = new Map();
let cursor;
do {
  const pagina = await api('GET', `/v1/convai/tools?page_size=100${cursor ? `&cursor=${cursor}` : ''}`);
  for (const t of pagina.tools ?? []) existentes.set(t.tool_config?.name, t.id);
  cursor = pagina.has_more ? pagina.next_cursor : undefined;
} while (cursor);

const ids = [];
for (const h of HERRAMIENTAS) {
  const config = configDe(h);
  const previo = existentes.get(h.name);
  if (previo) {
    await api('PATCH', `/v1/convai/tools/${previo}`, { tool_config: config });
    ids.push(previo);
    console.log(`  · ${h.name} actualizada`);
  } else {
    const creada = await api('POST', '/v1/convai/tools', { tool_config: config });
    ids.push(creada.id);
    console.log(`  · ${h.name} creada`);
  }
}

// --- 2. el agente constructor --------------------------------------------------

const lista = await api('GET', '/v1/convai/agents?page_size=100');
const previo = (lista.agents ?? []).find((a) => a.name === NOMBRE);

const conversationConfig = {
  agent: {
    language: 'es',
    prompt: {
      prompt: INSTRUCCIONES,
      tool_ids: ids,
      // Varias fases seguidas en un turno: sin esto arma el flujo de a una
      // fase por mensaje y la charla se vuelve interminable.
      enable_parallel_tool_calls: true,
    },
    // Vacío: en un chat habla primero la persona.
    first_message: '',
  },
  // Solo texto: el constructor no atiende llamadas.
  conversation: { text_only: true },
  tts: { model_id: VOZ_MULTILINGUE },
};

let id;
if (previo) {
  await api('PATCH', `/v1/convai/agents/${previo.agent_id}`, {
    name: NOMBRE,
    conversation_config: conversationConfig,
  });
  id = previo.agent_id;
  console.log(`\nConstructor actualizado.`);
} else {
  const creado = await api('POST', '/v1/convai/agents/create', {
    name: NOMBRE,
    conversation_config: conversationConfig,
  });
  id = creado.agent_id;
  console.log(`\nConstructor creado.`);
}

console.log(`\nPoné esto en el entorno:\n  ELEVENLABS_BUILDER_AGENT_ID=${id}`);
