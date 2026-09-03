#!/usr/bin/env node
/**
 * Deja el agente de ElevenLabs configurado como lo espera esta app.
 *
 * Hacer esto a mano en el panel son ~40 campos repartidos en cinco diálogos, y
 * un nombre de herramienta mal escrito falla en silencio: el agente cree que la
 * llamó, le inventa un folio al ciudadano y nadie se entera. Acá los nombres
 * salen del mismo lugar que los valida el backend.
 *
 *   node scripts/elevenlabs-setup.mjs [--env <archivo>] [--voz] [--sin-prompt]
 *
 * La llave sale del entorno (ELEVENLABS_API_KEY) o del archivo que le pases con
 * --env. Nunca se imprime.
 *
 *   --voz         además duplica el agente para llamadas (sin "solo texto") y
 *                 dice qué id poner en ELEVENLABS_VOICE_AGENT_ID
 *   --sin-prompt  no toca el system prompt del panel; solo herramientas y ajustes
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
      'Asigna el trabajo a un responsable del equipo municipal, en el CRM. Si no ' +
      'sabés a quién, llamala sin responsable y te devuelve la lista de los que ' +
      'existen. Nunca inventes un nombre.',
    props: {
      titulo: ['Qué hay que hacer', true],
      responsable: ['Nombre o email; si no existe se devuelven los que sí', false],
      detalle: ['Contexto para quien la reciba', false],
      tipo: ['Tipo de tarea', false, ['TODO', 'CALL', 'EMAIL']],
      prioridad: ['Prioridad de la tarea', false, ['LOW', 'MEDIUM', 'HIGH']],
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

/** Las que la app manda en cada turno. Sin declararlas, la conexión las rechaza. */
const VARIABLES = { nombre_ciudadano: 'María López', telefono: '+50497616546' };

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
    expects_response: true,
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
// que escriba.
cc.agent.first_message = '';
cc.agent.prompt.tool_ids = idsHerramientas;
cc.agent.dynamic_variables = { dynamic_variable_placeholders: VARIABLES };
cc.conversation = { ...(cc.conversation ?? {}), text_only: true };

if (!tiene('--sin-prompt')) {
  // El primer bloque de código del documento ES el prompt completo.
  const doc = readFileSync(join(RAIZ, 'docs/agente/system-prompt.md'), 'utf8');
  const bloque = /```\n([\s\S]*?)\n```/.exec(doc);
  if (!bloque) throw new Error('No encontré el bloque del prompt en docs/agente/system-prompt.md');
  cc.agent.prompt.prompt = bloque[1];
}

await api('PATCH', `/v1/convai/agents/${AGENT_ID}`, { conversation_config: cc });
console.log(`\nAgente de texto (${agente.name ?? AGENT_ID})`);
console.log('  · idioma es · solo texto activado · primer mensaje vacío');
console.log(`  · variables declaradas: ${Object.keys(VARIABLES).join(', ')}`);
console.log(`  · ${idsHerramientas.length} herramientas enganchadas`);
console.log(tiene('--sin-prompt') ? '  · prompt: sin tocar' : '  · prompt actualizado desde el documento');

// --- 3. el gemelo de voz -------------------------------------------------------

if (tiene('--voz')) {
  /*
   * "Solo texto" apaga el motor de voz: el agente que atiende WhatsApp bien no
   * puede levantar una llamada. El gemelo es el mismo prompt y la misma base,
   * con esa opción apagada y sin la regla de "esto es un chat".
   */
  const copia = await api('POST', `/v1/convai/agents/${AGENT_ID}/duplicate`, {
    name: `${agente.name ?? 'Línea 100'} — voz`,
  });
  const vozCc = (await api('GET', `/v1/convai/agents/${copia.agent_id}`)).conversation_config;
  vozCc.conversation = { ...(vozCc.conversation ?? {}), text_only: false };
  vozCc.agent.prompt.prompt = vozCc.agent.prompt.prompt
    .replace(/\nESTO ES UN CHAT DE WHATSAPP[\s\S]*?misma conversación\.\n/, '\n')
    .concat(
      '\n\nESTO ES UNA LLAMADA\n' +
        'Te están escuchando, no leyendo. No dictes enlaces ni listas numeradas.\n' +
        'Los números decilos dígito por dígito. Si escalás, avisá que alguien del\n' +
        'equipo va a devolver la llamada: no dejes a la persona esperando en línea.\n',
    );
  await api('PATCH', `/v1/convai/agents/${copia.agent_id}`, { conversation_config: vozCc });

  console.log('\nAgente de voz');
  console.log('  · duplicado con las mismas herramientas y base');
  console.log('  · solo texto DESACTIVADO · prompt adaptado a llamada');
  console.log(`\n  Agregá esta variable de entorno en Vercel:\n  ELEVENLABS_VOICE_AGENT_ID=${copia.agent_id}`);
}

console.log('\nListo.');
