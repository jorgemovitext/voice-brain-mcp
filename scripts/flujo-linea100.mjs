#!/usr/bin/env node
/**
 * El flujo de la Línea 100, como código.
 *
 * Vive acá y no solo en el panel del proveedor porque es lógica de producto:
 * decide si un vecino entra por emergencia, por reporte, por consulta o queda
 * fuera de nuestra competencia. Un cambio ahí se revisa como cualquier otro
 * cambio, y si alguien lo rompe desde la consola, esto lo devuelve.
 *
 *   node scripts/flujo-linea100.mjs <archivo-de-respaldo.json>
 *
 * Guarda el flujo ACTUAL en el archivo que le pases ANTES de escribir el nuevo.
 * Necesita ELEVENLABS_API_KEY y ELEVENLABS_AGENT_ID en .env.
 *
 * Las cuatro ramas del triage y las dos de recopilación se probaron una por una
 * desde el banco de pruebas de la consola; los comentarios de abajo cuentan qué
 * falló en cada intento y por qué el texto dice lo que dice.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n')
  .map(l=>/^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const { AgentesService } = await import(process.cwd()+'/apps/api/dist/agentes/agentes.service.js');
const s = new AgentesService({ get: (k,d) => env[k] ?? d });
const id = env.ELEVENLABS_AGENT_ID;

writeFileSync(process.argv[2], JSON.stringify(await s.flujo(id), null, 2));

const F = (id, nombre, x, y, instrucciones, herramientas = [], alEntrar = 'auto', orden = undefined) =>
  ({ id, tipo: 'fase', nombre, x, y, instrucciones, herramientas, alEntrar, orden });

const nodos = [
  { id: 'inicio', tipo: 'inicio', nombre: 'Inicio', x: 40, y: 300 },

  F('triage', 'Saludo y motivo', 300, 300,
`Saludá con calidez, de vos, y preguntale en qué lo podés ayudar.

Tu trabajo acá es UNO: entender para qué escribe. No pidas datos todavía.

Distinguí entre cuatro cosas:
· Hay alguien en peligro ahora mismo (derrumbe con gente, poste caído con cable vivo, inundación con personas atrapadas).
· Quiere reportar un problema de la ciudad.
· Pregunta por un reporte que ya hizo.
· El problema no es de la AMDC (otra municipalidad, un servicio privado).

QUÉ ES NUESTRO Y QUÉ NO
Sí atendemos: baches y calles, alumbrado público (el poste de la calle),
derrumbes, basura y quebradas, semáforos, aguas negras de la red municipal.
NO atendemos: cortes de energía en las casas (eso es ENEE), agua potable
fuera de nuestra red (SANAA), teléfono e internet, y cualquier problema de
otro municipio.

Ojo con la diferencia: "no alumbra el poste de la calle" es nuestro; "se fue
la luz en mi casa o en toda la cuadra" es de la ENEE.

Si no te queda claro, preguntá una sola cosa para aclararlo.`,
    ['actualizar_ficha'],
    'auto',
    /*
     * El orden en que se evalúan las salidas, y no es cosmético: gana la
     * PRIMERA condición que se cumple. La emergencia va antes que todo — si
     * "quiere reportar un problema" se evaluara primero, un derrumbe con gente
     * atrapada entraría por la rama tranquila y nadie avisaría a la cuadrilla.
     */
    ['e1', 'e4', 'e3', 'e2']),

  F('emergencia', 'Emergencia', 560, 60,
`Alguien está en peligro. Esto va antes que el reporte.

Conseguí SOLO dos cosas y en este orden: dónde es, y si hay personas atrapadas o heridas. Nada más.

Avisá a la cuadrilla con avisar_autoridad EN ESTE MISMO TURNO, antes de contestarle, con lo que ya tengas. Aunque solo sepas la colonia, avisá: llegar con una dirección aproximada es infinitamente mejor que no salir.

Nunca digas "ya estoy avisando" sin haber llamado la herramienta. Si lo decís sin hacerlo, nadie sale.

Decile que llame al 911 para bomberos y cuerpos de socorro: nosotros avisamos a la cuadrilla municipal, no somos el servicio de emergencia.

Quedate con la persona. Después, si se puede, seguí con el reporte.`,
    ['avisar_autoridad', 'actualizar_ficha', 'escalar_a_humano'], 'generate_immediately'),

  F('recopilar', 'Recopilar el reporte', 560, 240,
`Necesitás tres datos, y los pedís de a uno:
1. Qué está pasando (el tipo de problema)
2. Dónde: colonia o barrio, calle y una referencia ("frente a", "a la par de")
3. Desde cuándo, qué tan grave es y a quién afecta

Pedile foto y, sobre todo, la ubicación de WhatsApp: resuelve las direcciones mejor que cualquier descripción.

Si ya tenés un dato porque la persona lo dijo, NO lo vuelvas a preguntar.

Nunca pidas número de identidad ni datos bancarios.`,
    ['actualizar_ficha']),

  F('consulta', 'Consulta de un reporte', 560, 420,
`Pregunta por un reporte anterior, no trae uno nuevo.

Pedile el número (AMDC-####). Si no lo tiene, pedile la colonia y de qué era, para poder buscarlo.

Vos NO podés ver el estado de un reporte. No inventes que está "en proceso" ni des fechas: eso lo consulta una persona del equipo.

Escalá a un compañero para que lo revise, y decíselo con claridad: alguien va a entrar a esta misma conversación.

Si además viene molesto porque nadie fue, escalá igual — no lo dejes con una disculpa nada más.`,
    ['escalar_a_humano', 'actualizar_ficha']),

  F('fuera', 'Fuera del Distrito Central', 560, 600,
`Esto no le toca a la AMDC.

Decíselo con amabilidad y sin tecnicismos, y sobre todo decile A QUIÉN le corresponde: otra municipalidad, la ENEE si es energía, el SANAA si es agua potable fuera de nuestra red.

No lo registres como reporte nuestro: un ticket que nadie va a atender es peor que no tenerlo.

Despedite bien. La persona hizo lo correcto en preguntar.`,
    ['actualizar_ficha']),

  F('registrar', 'Registrar y asignar', 830, 240,
`Ya tenés los tres datos. Repetí lo que entendiste para que la persona lo confirme.

Registrá el reporte y decile el número de seguimiento TAL CUAL te lo devuelve la herramienta. Nunca lo inventes ni lo cambies: si no te dio número, no hay número — decile la verdad, que quedó anotado y alguien lo va a retomar.

Después asigná la tarea a un responsable. Si no sabés a quién le toca, pedí la lista y elegí de ahí; nunca inventes un nombre.`,
    ['registrar_reporte', 'asignar_tarea', 'actualizar_ficha']),

  F('cierre', 'Cerrar', 1100, 300,
`Contale a qué cuadrilla se trasladó y preguntale si necesita algo más.

Si pregunta cuánto tarda, explicale que depende del tipo de reporte y de la cuadrilla, y que con su número puede consultar el estado.

Si aparece otro problema, volvé a empezar: es un reporte nuevo, no un agregado del anterior.`,
    ['actualizar_ficha']),

  { id: 'fin', tipo: 'fin', nombre: 'Fin', x: 1370, y: 300 },
];

const E = (id, desde, hasta, condicion = '') => ({ id, desde, hasta, condicion });

const aristas = [
  E('e0', 'inicio', 'triage'),
  // Cuatro ramas desde el triage: es donde se decide todo lo demás.
  E('e1', 'triage', 'emergencia', 'hay alguien en peligro ahora mismo: riesgo para la vida o la integridad'),
  E('e2', 'triage', 'recopilar', 'quiere reportar un problema de la ciudad y nadie está en peligro'),
  E('e3', 'triage', 'consulta', 'pregunta por un reporte que ya había hecho antes'),
  E('e4', 'triage', 'fuera', 'le corresponde a otra institución: corte de energía de la ENEE, agua potable del SANAA, teléfono o internet, o un problema de otro municipio'),
  E('e5', 'emergencia', 'recopilar', 'ya se avisó a la cuadrilla y la persona puede seguir dando los datos'),
  // Dos salidas desde recopilar: puede resultar que ni siquiera sea nuestro.
  E('e6', 'recopilar', 'registrar', 'ya tenés el tipo de problema, la ubicación y la descripción'),
  E('e7', 'recopilar', 'fuera', 'al conocer los detalles resulta que le corresponde a otra institución o a otro municipio'),
  E('e8', 'registrar', 'cierre'),
  E('e9', 'consulta', 'cierre', 'ya se escaló a una persona del equipo'),
  /*
   * CON condición, y no incondicional como estaba.
   *
   * El nodo Fin termina la conversación apenas se llega a él. Con una arista
   * sin condición, el agente entraba a "Fuera del Distrito Central" y saltaba
   * al Fin en el mismo turno, cerrando la conexión ANTES de decir nada: el
   * vecino escribía por un corte de luz y recibía silencio. Reproducido dos
   * veces en el banco de pruebas.
   */
  E('e10', 'fuera', 'fin', 'ya le dijiste a qué institución le corresponde y te despediste'),
  E('e11', 'cierre', 'fin', 'la persona no necesita nada más'),
];

await s.guardarFlujo(id, { nodos, aristas });
console.log(`guardado: ${nodos.length} nodos, ${aristas.length} conexiones`);

const d = await s.flujo(id);
const salidas = {};
for (const a of d.aristas) (salidas[a.desde] ??= []).push(a.hasta);
console.log('\nramas por nodo:');
for (const [n, hijos] of Object.entries(salidas)) {
  if (hijos.length > 1) console.log(`  ${n} → ${hijos.length} ramas`);
}
console.log(`\nreleído: ${d.nodos.length} nodos, ${d.aristas.length} conexiones`);
