#!/usr/bin/env node
/**
 * Deja el agente de ElevenLabs configurado como lo espera esta app.
 *
 * Hacer esto a mano en el panel son ~40 campos repartidos en cinco diálogos, y
 * un nombre de herramienta mal escrito falla en silencio: el agente cree que la
 * llamó, le inventa un folio al ciudadano y nadie se entera. Acá los nombres
 * salen del mismo lugar que los valida el backend.
 *
 *   node scripts/elevenlabs-setup.mjs [--env <archivo>] [--sin-prompt]
 *
 * La llave sale del entorno (ELEVENLABS_API_KEY) o del archivo que le pases con
 * --env. Nunca se imprime.
 *
 *   --sin-prompt  no toca el system prompt del panel; solo herramientas y ajustes
 *
 * Es UN SOLO agente para chat y llamada: el prompt se adapta con {{canal}}, que
 * la app manda en cada turno.
 *
 * Es idempotente: corrélo las veces que quieras. Las herramientas se emparejan
 * por nombre, así que no se duplican.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io';

/*
 * Las herramientas, tal como las ejecuta AgenteToolsService.
 *
 * Los `name` tienen que coincidir EXACTO con AgenteToolsService.NOMBRES, y las
 * claves de `properties` con lo que lee cada método: el agente manda lo que dice
 * este esquema y el backend lee lo que dice el suyo. Si se separan, el agente
 * llama bien y el ticket sale vacío.
 *
 * `expects_response: true` en las cuatro. Es el "Esperar respuesta" del panel, y
 * sin él el agente dispara la herramienta y sigue hablando sin leer lo que
 * devolvió: perdería el número de seguimiento y la lista de responsables, que es
 * justo lo que tiene que decirle al ciudadano.
 */
const HERRAMIENTAS = [
  {
    name: 'registrar_reporte',
    description:
      'Registra el reporte del ciudadano en el sistema municipal y devuelve el ' +
      'número de seguimiento. Usala SOLO cuando ya tengas el tipo de problema, ' +
      'la ubicación y la descripción.',
    props: {
      tipo_problema: ['Derrumbe, bache, fuga de agua, inundación, alumbrado…', true],
      ubicacion: ['Colonia o barrio, calle y una referencia para llegar', true],
      descripcion: ['Qué pasa, desde cuándo y a quién afecta', true],
    },
  },
  {
    name: 'avisar_autoridad',
    description:
      'Avisa de inmediato a la cuadrilla de emergencia. Usala cuando haya riesgo ' +
      'para la vida o la integridad de alguien, sin esperar a completar el reporte.',
    props: {
      motivo: ['Qué está pasando y por qué es urgente', true],
      ubicacion: ['Dónde es', true],
      detalle: ['Personas en riesgo, accesos, lo que ayude a la cuadrilla', false],
    },
  },
  {
    name: 'asignar_tarea',
    description:
      'Le pone responsable a la tarea del reporte, en el CRM. Usala SIEMPRE justo ' +
      'después de registrar_reporte: esa tarea nace sin dueño y sin dueño no la ' +
      'atiende nadie. Si no sabés a quién le toca, llamala sin responsable y te ' +
      'devuelve la lista real del portal. Nunca inventes un nombre.',
    props: {
      titulo: ['Qué hay que hacer', true],
      responsable: ['Nombre o email; si no existe se devuelven los que sí', false],
      detalle: ['Contexto para quien la reciba', false],
      tipo: ['Tipo de tarea', false, ['TODO', 'CALL', 'EMAIL']],
      prioridad: ['Prioridad de la tarea', false, ['LOW', 'MEDIUM', 'HIGH']],
    },
  },
  {
    name: 'actualizar_ficha',
    /*
     * La única que NO espera respuesta. El agente no usa lo que devuelve —es un
     * panel interno del operador—, así que hacerlo esperar el viaje de ida y
     * vuelta le sumaba ~700 ms a CADA turno para nada. La escritura se hace
     * igual: el cliente espera las herramientas en vuelo antes de cerrar.
     */
    espera: false,
    description:
      'Anota en el panel interno del operador lo que vas entendiendo del caso. ' +
      'Llamala apenas sepas algo nuevo —no esperes a tener todo— y mandá SOLO ' +
      'los campos que cambiaron en este turno. El ciudadano no ve esto: nunca ' +
      'le menciones que lo estás anotando.',
    props: {
      tipo_problema: ['Derrumbe, bache, fuga de agua, inundación, alumbrado…', false],
      ubicacion: ['Colonia o barrio, calle y una referencia', false],
      descripcion: ['Qué pasa, en una línea', false],
      riesgo: ['Riesgo para la gente', false, ['bajo', 'medio', 'alto']],
      afectados: ['A cuántos afecta o quiénes están en riesgo', false],
      estado: ['En qué punto va el caso', false, [
        'recopilando',
        'listo para registrar',
        'registrado',
        'cuadrilla avisada',
        'escalado',
      ]],
      proximo_paso: ['Qué vas a hacer a continuación', false],
      resumen: [
        'Qué está pasando, en una o dos líneas, para que un operador que abre ' +
          'el chat ahora entienda el caso sin leerlo entero. Reescribilo cada ' +
          'vez que cambie algo, no lo vayas alargando.',
        false,
      ],
      animo: ['Cómo se siente la persona', false, ['tranquilo', 'preocupado', 'molesto', 'angustiado']],
    },
  },
  {
    name: 'escalar_a_humano',
    description:
      'Pide que una persona del equipo entre a esta conversación. Usala cuando el ' +
      'ciudadano pida hablar con alguien, cuando reclame por un reporte anterior, ' +
      'o cuando la situación te supere.',
    props: {
      motivo: ['Por qué hace falta una persona del equipo', true],
      urgencia: ['Usá "alta" si no puede esperar', false, ['alta', 'normal']],
    },
  },
];

/**
 * Las que la app manda en cada turno. Sin declararlas, la conexión las rechaza.
 *
 * `canal` es la que deja que un mismo agente sirva para las dos cosas: en el
 * chat vale "WhatsApp" y en la llamada "llamada", y el prompt se ramifica. Sin
 * ella el agente pide "no colgués" por WhatsApp y dicta URLs por teléfono.
 */
const VARIABLES = {
  nombre_ciudadano: 'María López',
  telefono: '+50497616546',
  canal: 'WhatsApp',
};

// --- argumentos y credenciales -------------------------------------------------

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valorDe = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const entorno = { ...process.env };
const archivoEnv = valorDe('--env');
if (archivoEnv) {
  // Formato .env plano: CLAVE=valor. Alcanza para lo que baja `vercel env pull`.
  for (const linea of readFileSync(archivoEnv, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linea);
    if (m) entorno[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const KEY = entorno.ELEVENLABS_API_KEY;
const AGENT_ID = entorno.ELEVENLABS_AGENT_ID;
if (!KEY || !AGENT_ID) {
  console.error(
    'Faltan ELEVENLABS_API_KEY y/o ELEVENLABS_AGENT_ID.\n' +
      'Pasalos por entorno, o bajá los de producción y usá --env:\n\n' +
      '  vercel env pull .env.produccion --environment=production\n' +
      '  node scripts/elevenlabs-setup.mjs --env .env.produccion\n',
  );
  process.exit(1);
}

/** Una llamada a la API. Si falla, muestra el cuerpo: el mensaje de ElevenLabs es útil. */
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

/** Del formato compacto de arriba al JSON Schema que espera ElevenLabs. */
function configDe(h) {
  const properties = {};
  const required = [];
  for (const [nombre, [descripcion, obligatorio, valores]] of Object.entries(h.props)) {
    properties[nombre] = { type: 'string', description: descripcion };
    if (valores) properties[nombre].enum = valores;
    if (obligatorio) required.push(nombre);
  }
  return {
    type: 'client',
    name: h.name,
    description: h.description,
    parameters: { type: 'object', properties, required },
    // Por defecto sí: el agente usa el folio y la lista de responsables que le
    // devolvemos, y sin esperar seguiría hablando sin haberlos leído.
    expects_response: h.espera !== false,
    response_timeout_secs: 30,
  };
}

// --- 1. herramientas -----------------------------------------------------------

console.log('Herramientas');
const existentes = new Map();
let cursor;
do {
  // Paginado: con 30 por página y herramientas de sistema en la cuenta, la
  // cuarta se puede caer de la primera página y se crearía duplicada.
  const q = new URLSearchParams({ page_size: '100', ...(cursor ? { cursor } : {}) });
  const pagina = await api('GET', `/v1/convai/tools?${q}`);
  for (const t of pagina.tools ?? []) existentes.set(t.tool_config?.name, t.id);
  cursor = pagina.has_more ? pagina.next_cursor : undefined;
} while (cursor);

const idsHerramientas = [];
for (const h of HERRAMIENTAS) {
  const config = configDe(h);
  const previo = existentes.get(h.name);
  if (previo) {
    await api('PATCH', `/v1/convai/tools/${previo}`, { tool_config: config });
    idsHerramientas.push(previo);
    console.log(`  · ${h.name} actualizada`);
  } else {
    const creada = await api('POST', '/v1/convai/tools', { tool_config: config });
    idsHerramientas.push(creada.id);
    console.log(`  · ${h.name} creada`);
  }
}

// --- 2. el agente de texto -----------------------------------------------------

/*
 * Se lee el agente entero, se cambia lo nuestro y se manda de vuelta. La API
 * documenta el PATCH como parcial pero no dice hasta qué profundidad mezcla: si
 * reemplazara el objeto `prompt` completo, mandar solo `tool_ids` borraría el
 * system prompt. Leer primero cuesta una llamada y quita la duda.
 */
const agente = await api('GET', `/v1/convai/agents/${AGENT_ID}`);
const cc = agente.conversation_config ?? {};
cc.agent = cc.agent ?? {};
cc.agent.prompt = cc.agent.prompt ?? {};

cc.agent.language = 'es';
// En WhatsApp habla primero el vecino: un saludo automático llegaría antes de
// que escriba. En la llamada saluda igual, guiado por el prompt.
cc.agent.first_message = '';
cc.agent.dynamic_variables = { dynamic_variable_placeholders: VARIABLES };

/*
 * UN SOLO AGENTE para chat y llamada, así que "solo texto" queda apagado: esa
 * opción le apaga el motor de voz y con ella puesta la llamada no levanta. Las
 * acotaciones que el modo voz mete en el texto (`[pausa breve]`) las quita el
 * backend antes de mandar el WhatsApp — ver ElevenLabsService.sinEtiquetasDeVoz.
 */
cc.conversation = { ...(cc.conversation ?? {}), text_only: false };

/*
 * La API rechaza `tools` y `tool_ids` juntos, así que hay que borrar el arreglo
 * viejo. Ahí adentro vienen las de sistema —end_call, language_detection—, que
 * son las que dejan colgar la llamada, y NO existen en /v1/convai/tools: no se
 * pueden convertir a id.
 *
 * Se pueden borrar igual porque `built_in_tools` las tiene por su cuenta:
 * `tools` es un espejo en el formato viejo. Pero eso se verifica, no se asume —
 * perder end_call dejaría al agente sin forma de terminar una llamada, y no lo
 * notaríamos hasta tener a un vecino atrapado en la línea.
 */
const activasDeSistema = Object.entries(cc.agent.prompt.built_in_tools ?? {})
  .filter(([, v]) => v)
  .map(([k]) => k);
for (const t of cc.agent.prompt.tools ?? []) {
  if (t.type === 'system' && !activasDeSistema.includes(t.name)) {
    throw new Error(
      `"${t.name}" está en prompt.tools pero no activa en built_in_tools: ` +
        'borrar el arreglo la perdería. Revisalo antes de seguir.',
    );
  }
}
delete cc.agent.prompt.tools;
delete cc.agent.tools;
cc.agent.prompt.tool_ids = idsHerramientas;

/*
 * En serie, el agente elige UNA herramienta por turno, y siempre gana la que
 * hace algo visible para el ciudadano: contestaba el saludo o abría el ticket,
 * pero nunca llenaba la ficha del riel. En paralelo puede anotar y actuar en el
 * mismo turno, que es lo que hace que el panel se vea crecer mientras conversan.
 */
cc.agent.prompt.enable_parallel_tool_calls = true;

if (!tiene('--sin-prompt')) {
  // El primer bloque de código del documento ES el prompt completo.
  const doc = readFileSync(join(RAIZ, 'docs/agente/system-prompt.md'), 'utf8');
  const bloque = /```\n([\s\S]*?)\n```/.exec(doc);
  if (!bloque) throw new Error('No encontré el bloque del prompt en docs/agente/system-prompt.md');
  cc.agent.prompt.prompt = bloque[1];
}

/*
 * Permiso para que la app apague el audio POR CONVERSACIÓN.
 *
 * El agente queda en modo voz —si no, no levanta llamadas—, pero cada turno de
 * WhatsApp abre la conexión pidiendo `text_only`. Sin audio que nadie escucha,
 * eso pasa de facturar por minuto a facturar por mensaje.
 *
 * ElevenLabs trae estos permisos en deny-by-default y, si la app manda un
 * override no habilitado, CORTA la conversación en vez de ignorarlo. Así que
 * este bloque no es opcional: sin él, el chat deja de responder.
 */
const plataforma = agente.platform_settings ?? {};
const overrides = plataforma.overrides ?? {};
const cco = overrides.conversation_config_override ?? {};
cco.conversation = { ...(cco.conversation ?? {}), text_only: true };
overrides.conversation_config_override = cco;
plataforma.overrides = overrides;

await api('PATCH', `/v1/convai/agents/${AGENT_ID}`, {
  conversation_config: cc,
  platform_settings: plataforma,
});
console.log(`\nAgente (${agente.name ?? AGENT_ID})`);
console.log('  · permiso de override de text_only: habilitado');
console.log('  · idioma es · primer mensaje vacío');
console.log('  · solo texto APAGADO: el mismo agente atiende chat y llamada');
console.log(`  · variables declaradas: ${Object.keys(VARIABLES).join(', ')}`);
console.log(`  · herramientas enganchadas: ${cc.agent.prompt.tool_ids.length} + de sistema: ${activasDeSistema.join(", ")}`);
console.log(tiene('--sin-prompt') ? '  · prompt: sin tocar' : '  · prompt actualizado desde el documento');

console.log('\nListo.');
