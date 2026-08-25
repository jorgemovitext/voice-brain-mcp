/**
 * Corrige el flujo de la Pearl "Línea 100 AMDC Whatsapp" en producción.
 *
 * Problema: el nodo `emergency` deriva a un operador humano en vez de entrar
 * a la rama que ya existe para resolver (emCollectLoc → … → emCreateTicket).
 * Trece nodos quedaban huérfanos. Otros dos nodos derivan por motivos que no
 * lo justifican (falta un dato, el ciudadano no sabe la ubicación).
 *
 * Respalda el estado actual antes de escribir.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath y no `.pathname`: la ruta del proyecto tiene un espacio y
// quedaba como %20, así que el respaldo fallaba al escribirse.
const S = fileURLToPath(new URL('.', import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const B = 'https://api.nlpearl.ai';
const H = { Authorization: `Bearer ${env.NLPEARL_ACCOUNT_ID}:${env.NLPEARL_API_KEY}`, 'Content-Type': 'application/json' };
const WA = '6a88a6da0137ea6b03c574c2';

const g = await (await fetch(`${B}/v2/Pearl/${WA}/Settings`, { headers: H })).json();
fs.writeFileSync(`${S}/respaldo-antes-de-editar.json`, JSON.stringify(g, null, 2));
console.log('Respaldo guardado. Nodos:', g.pearl.nodes.length, '| tags:', g.pearl.indicatorTags.length);

const nodes = structuredClone(g.pearl.nodes);
const set = (id, cambios) => {
  const n = nodes.find((x) => x.nodeId === id);
  if (!n) throw new Error('No existe el nodo ' + id);
  Object.assign(n, cambios);
};

// 1) La emergencia deja de derivar: entra a la rama que ya resuelve.
set('emergency', {
  script: 'Entiendo, esto es urgente. Si hay personas en peligro inmediato, llame al 911 ahora mismo. Yo voy a registrar su reporte de una vez para movilizar a los equipos de la AMDC — solo necesito unos datos rápidos.',
  instructions: 'PRIORIDAD: resolver acá, sin transferir. Si hay riesgo de vida, indicar el 911 y CONTINUAR igual con el reporte. Recopilar los datos uno por uno con preguntas cortas. Pasar a un operador SOLO si el ciudadano lo pide explícitamente.',
  transitions: [
    { name: 'Continuar con el reporte de emergencia', toNodeId: 'emCollectLoc' },
    { name: 'El ciudadano pide expresamente hablar con una persona', toNodeId: 'handoffEmergency' },
  ],
});

// 2) Que falte un dato no es motivo para derivar.
set('collectDetails', {
  // NL Pearl limita las instrucciones a 250 caracteres.
  instructions: 'Guardar vía/acera en {tipo_espacio}, obstrucción en {obstruye_paso}, tiempo en {tiempo_observado}. Aceptar "no sé" y seguir: un dato faltante NO impide registrar. Máx 3 rondas. Pasar con una persona SOLO si el ciudadano lo pide.',
  transitions: [
    { name: 'Detalles proporcionados o no disponibles', toNodeId: 'offerPhoto' },
    { name: 'Ciudadano pide expresamente hablar con una persona', toNodeId: 'handoffNoEmergency' },
  ],
});

// 3) No saber la ubicación exacta tampoco: se acepta una referencia.
set('emCollectLoc', {
  instructions: 'Pedir la ubicación lo más precisa posible. Si el ciudadano no la sabe o no quiere darla, aceptar una referencia aproximada y CONTINUAR — el reporte se registra igual. No transferir por esto.',
  transitions: [
    { name: 'Ubicación o referencia proporcionada', toNodeId: 'emGeocode' },
    { name: 'Ciudadano pide expresamente hablar con una persona', toNodeId: 'handoffNoEmergency' },
  ],
});

/*
 * Los tags van completos menos "Consulta General" (autorizado por el usuario):
 * la API solo acepta 9 colores y sin quitar uno los duplicados hacen fallar
 * el PUT entero. Los ids deben ser exactamente 6 letras, sin dígitos.
 */
const L = 'abcdefghijklmnopqrstuvwxyz';
const usados = new Set();
const indicatorTags = g.pearl.indicatorTags
  .filter((t) => t.name !== 'Consulta General')
  .map((t, i) => {
    let color = t.color;
    while (usados.has(color)) color = (color % 9) + 1;
    usados.add(color);
    return { ...t, id: (L[i] + L[(i + 5) % 26] + L[(i + 11) % 26] + 'tag').slice(0, 6), color };
  });
console.log('tags a enviar:', indicatorTags.length, '| colores:', indicatorTags.map((t) => t.color).join(','));

// `variables` va en la RAÍZ del cuerpo, no dentro de `pearl`.
const variables = (g.variables || []).filter((v) => v.group === 2 && !v.readOnly);

const r = await fetch(`${B}/v2/Pearl/Text/${WA}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ name: g.name, pearl: { ...g.pearl, nodes, indicatorTags }, variables, inbound: g.inbound }),
});
console.log('\nPUT producción →', r.status);
console.log((await r.text()).slice(0, 400));
