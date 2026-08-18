#!/usr/bin/env node
/**
 * Corre el flujo demo end-to-end contra la API (debe estar levantada:
 * `npm run dev:api`). Dispara POST /api/demo/run y va imprimiendo los
 * pasos del flujo hasta que termina.
 */
const BASE = process.env.API_URL ?? 'http://localhost:3000';

async function main() {
  console.log(`▶ Corriendo demo contra ${BASE} …\n`);
  const run = await fetch(`${BASE}/api/demo/run`, { method: 'POST' });
  if (!run.ok) throw new Error(`POST /api/demo/run → ${run.status}`);
  const { contactId } = await run.json();

  let printed = 0;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}/api/demo/status`);
    const { running, steps } = await res.json();
    for (; printed < steps.length; printed++) {
      const s = steps[printed];
      console.log(`  [${s.at.slice(11, 19)}] ${s.step.padEnd(9)} ${s.title}`);
    }
    if (!running) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n✔ Demo completa. Contexto del contacto: ${BASE}/api/contacts/${contactId}/context`);
  console.log(`  Consola: http://localhost:4200/contacts/${contactId}`);
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
