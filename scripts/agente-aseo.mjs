/*
 * Crea el agente de ASEO: reportes de basura acumulada, escalados a quien
 * corresponde.
 *
 * Se hace por script y no desde el chat del creador porque el Constructor
 * todavía no contesta (ElevenLabs cierra la conexión sin decir por qué). El
 * resultado es el mismo agente que habría salido de ahí: creado, con sus
 * herramientas y con su flujo, y editable desde la consola como cualquier otro.
 *
 *   node scripts/agente-aseo.mjs
 */
import 'dotenv/config';

const API = process.env.ELEVENLABS_API_URL ?? 'https://api.elevenlabs.io';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('Falta ELEVENLABS_API_KEY.');
  process.exit(1);
}

const NOMBRE = 'Aseo 100';
const VOZ_MULTILINGUE = 'eleven_flash_v2_5';

const INSTRUCCIONES = [
  'Sos el agente de aseo de la Línea 100 de la AMDC, en Tegucigalpa, Honduras.',
  'Atendés a vecinos que reportan basura acumulada, botaderos clandestinos y',
  'contenedores desbordados.',
  '',
  'Cómo hablás:',
  '- Español de Honduras, de vos, cálido y directo. Frases cortas.',
  '- Preguntá de a UNA cosa. Nadie contesta tres preguntas juntas.',
  '- Nunca prometas una fecha de recolección: no la sabés.',
  '',
  'Qué necesitás para registrar un reporte, en este orden:',
  '1. Qué es (basura acumulada, botadero, contenedor desbordado, animal muerto).',
  '2. Dónde: colonia o barrio, calle y un punto de referencia para llegar.',
  '3. Desde cuándo, y si obstruye el paso o está junto a una escuela o mercado.',
  '',
  'Cuándo es EMERGENCIA SANITARIA y avisás a la autoridad antes de terminar el',
  'reporte: hay animales muertos, aguas negras mezcladas, quema de basura, o el',
  'foco está pegado a una escuela, un centro de salud o un mercado. En esos',
  'casos avisá primero y seguí recopilando después.',
  '',
  'Si el foco está fuera del Distrito Central, decilo con amabilidad y explicá a',
  'qué municipalidad le corresponde. No registres el reporte.',
  '',
  'Si el vecino se pone agresivo o pide hablar con una persona, escalá.',
  '',
  'Cerrá siempre diciendo el número de reporte y a qué cuadrilla se trasladó.',
].join('\n');

/** Las fases, en orden. La primera es la entrada. */
const FASES = [
  {
    id: 'start_node',
    tipo: 'inicio',
    nombre: 'Saludo y motivo',
    instrucciones:
      'Saludá con calidez, de vos, y preguntá en qué le podés ayudar. Tu trabajo acá es UNO: ' +
      'entender si reporta basura, si pregunta por un reporte anterior, o si es otra cosa.',
    herramientas: ['actualizar_ficha'],
  },
  {
    id: 'emergencia',
    tipo: 'fase',
    nombre: 'Emergencia sanitaria',
    instrucciones:
      'Hay riesgo para la salud. Avisá a la autoridad AHORA, antes de completar el reporte. ' +
      'Conseguí solo dos cosas y en este orden: dónde es, y qué hay exactamente.',
    herramientas: ['avisar_autoridad', 'actualizar_ficha'],
  },
  {
    id: 'recopilar',
    tipo: 'fase',
    nombre: 'Recopilar el reporte',
    instrucciones:
      'Necesitás tres datos y los pedís de a uno: 1. Qué es. 2. Dónde: colonia, calle y ' +
      'referencia. 3. Desde cuándo y si obstruye el paso. No pases a registrar sin los tres.',
    herramientas: ['actualizar_ficha'],
  },
  {
    id: 'fuera',
    tipo: 'fase',
    nombre: 'Fuera del Distrito Central',
    instrucciones:
      'Esto no le toca a la AMDC. Decíselo con amabilidad y sin tecnicismos, y sobre todo ' +
      'decile A QUIÉN le corresponde. No registres nada.',
    herramientas: ['actualizar_ficha'],
  },
  {
    id: 'registrar',
    tipo: 'fase',
    nombre: 'Registrar y escalar',
    instrucciones:
      'Ya tenés los tres datos. Repetí lo que entendiste para que la persona lo confirme. ' +
      'Registrá el reporte y asigná la tarea a la cuadrilla de aseo que corresponda.',
    herramientas: ['registrar_reporte', 'asignar_tarea', 'actualizar_ficha'],
  },
  {
    id: 'persona',
    tipo: 'fase',
    nombre: 'Pasar a una persona',
    instrucciones:
      'Pidió hablar con alguien o se puso agresivo. Escalá sin discutir y decile que ya ' +
      'avisaste al equipo.',
    herramientas: ['escalar_a_humano', 'actualizar_ficha'],
  },
  {
    id: 'cierre',
    tipo: 'fin',
    nombre: 'Cerrar',
    instrucciones:
      'Contale el número de reporte y a qué cuadrilla se trasladó. Preguntá si necesita algo más.',
    herramientas: ['actualizar_ficha'],
  },
];

/*
 * Las salidas, EN ORDEN DE EVALUACIÓN. Gana la primera que se cumple, así que
 * lo urgente va antes que lo general: si "quiere reportar basura" se evaluara
 * primero, una emergencia sanitaria entraría por la rama tranquila.
 */
const SALIDAS = [
  ['start_node', 'persona', 'pide hablar con una persona o está molesto'],
  ['start_node', 'emergencia', 'hay animales muertos, aguas negras, quema, o está junto a una escuela, centro de salud o mercado'],
  ['start_node', 'fuera', 'el foco está fuera del Distrito Central'],
  ['start_node', 'recopilar', 'quiere reportar basura acumulada o un botadero'],
  ['emergencia', 'recopilar', 'ya se avisó a la autoridad y falta completar el reporte'],
  ['recopilar', 'registrar', 'ya tenés qué es, dónde y desde cuándo'],
  ['registrar', 'cierre', 'el reporte quedó registrado'],
  ['fuera', 'cierre', 'ya le dijiste a qué municipalidad le corresponde'],
  ['persona', 'cierre', 'ya se escaló a una persona'],
];

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status}\n${texto.slice(0, 500)}`);
  return texto ? JSON.parse(texto) : {};
}

// --- Herramientas de la cuenta, por nombre ------------------------------------

const catalogo = new Map();
let cursor;
do {
  const p = await api('GET', `/v1/convai/tools?page_size=100${cursor ? `&cursor=${cursor}` : ''}`);
  for (const t of p.tools ?? []) catalogo.set(t.tool_config?.name, t.id);
  cursor = p.has_more ? p.next_cursor : undefined;
} while (cursor);

const usadas = [...new Set(FASES.flatMap((f) => f.herramientas))];
const faltan = usadas.filter((n) => !catalogo.has(n));
if (faltan.length) {
  console.error(`No existen en la cuenta: ${faltan.join(', ')}. Corré antes elevenlabs-setup.mjs.`);
  process.exit(1);
}

// --- El agente, idempotente ----------------------------------------------------

const lista = await api('GET', '/v1/convai/agents?page_size=100');
const previo = (lista.agents ?? []).find((a) => a.name === NOMBRE);

const conversationConfig = {
  agent: {
    language: 'es',
    prompt: { prompt: INSTRUCCIONES, tool_ids: usadas.map((n) => catalogo.get(n)) },
    // Vacío: en un chat habla primero la persona.
    first_message: '',
  },
  tts: { model_id: VOZ_MULTILINGUE },
};

let id;
if (previo) {
  await api('PATCH', `/v1/convai/agents/${previo.agent_id}`, {
    name: NOMBRE,
    conversation_config: conversationConfig,
  });
  id = previo.agent_id;
  console.log('Agente actualizado.');
} else {
  const creado = await api('POST', '/v1/convai/agents/create', {
    name: NOMBRE,
    conversation_config: conversationConfig,
  });
  id = creado.agent_id;
  console.log('Agente creado.');
}

// --- El flujo ------------------------------------------------------------------

const nodes = {};
FASES.forEach((f, i) => {
  nodes[f.id] = {
    type: f.tipo === 'inicio' ? 'start' : f.tipo === 'fin' ? 'end' : 'override_agent',
    label: f.nombre,
    // En zigzag: puestas por nosotros y no por el modelo, que las encima.
    position: { x: 140 + (i % 2) * 300, y: 80 + i * 190 },
    ...(f.tipo === 'fase' || f.tipo === 'inicio'
      ? {
          override_agent: {
            prompt: { prompt: f.instrucciones },
            tool_ids: (f.herramientas ?? []).map((n) => catalogo.get(n)),
          },
        }
      : {}),
  };
});

const edges = {};
SALIDAS.forEach(([desde, hasta, condicion], i) => {
  edges[`e${i + 1}`] = {
    source: desde,
    target: hasta,
    // El campo es `condition`, no `prompt`: con `prompt` la API contesta 422
    // pidiendo `condition`, que es el nombre que espera.
    forward_condition: condicion
      ? { type: 'llm', condition: condicion }
      : { type: 'unconditional' },
  };
});

// El orden de las salidas de cada fase ES el orden de evaluación.
for (const [clave, nodo] of Object.entries(nodes)) {
  const suyas = Object.entries(edges).filter(([, e]) => e.source === clave).map(([id]) => id);
  if (suyas.length > 1) nodo.edge_order = suyas;
}

await api('PATCH', `/v1/convai/agents/${id}`, { workflow: { nodes, edges } });

console.log(`Flujo guardado: ${Object.keys(nodes).length} fases, ${Object.keys(edges).length} salidas.`);
console.log(`\nAbrilo en la consola:\n  /agentes/${id}`);
