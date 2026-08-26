import { ConfigService } from '@nestjs/config';
import { WebhookLogService } from './webhook-log.service';

/*
 * El bug que cubren estas pruebas:
 *
 * `push()` agendaba el guardado y nadie lo esperaba. En Vercel la instancia se
 * congela apenas se devuelve la respuesta, así que el `put` quedaba a medias y
 * el evento se perdía — y como la copia en memoria muere con la instancia, la
 * consola mostraba Actividad vacía y "Entrantes de Gupshup: NUNCA" aunque el
 * proveedor sí nos hubiera llamado. O sea: el síntoma y el diagnóstico
 * fallaban a la vez.
 *
 * Se simula el congelamiento resolviendo el `put` DESPUÉS de que el
 * controlador ya respondió: si nadie esperó, el evento no llegó al almacén.
 */

/**
 * Almacén de Blob simulado, con el `put` bajo control del test.
 *
 * `completar()` espera a que haya un `put` en vuelo antes de soltarlo: los
 * guardados se encadenan con `.then`, así que arrancan en un microtask y no
 * durante el `push()`.
 */
function blobFalso() {
  const escrituras: string[] = [];
  let soltar: (() => void) | null = null;

  return {
    escrituras,
    completar: async () => {
      for (let intento = 0; !soltar && intento < 50; intento++) await Promise.resolve();
      if (!soltar) throw new Error('no había ningún guardado en vuelo');
      const ahora = soltar;
      soltar = null;
      ahora();
    },
    put: (contenido: string) =>
      new Promise<void>((resolve) => {
        soltar = () => {
          escrituras.push(contenido);
          resolve();
        };
      }),
  };
}

function servicio(blob: ReturnType<typeof blobFalso>): WebhookLogService {
  const log = new WebhookLogService({
    get: (clave: string, def?: unknown) => (clave === 'BLOB_READ_WRITE_TOKEN' ? 'token-de-prueba' : def),
  } as unknown as ConfigService);
  // El `put` real habla con Vercel Blob; acá interesa solo cuándo resuelve.
  (log as unknown as { persist: () => Promise<void> }).persist = () =>
    blob.put(JSON.stringify((log as unknown as { events: unknown[] }).events));
  return log;
}

describe('WebhookLogService: la bitácora sobrevive al congelamiento', () => {
  it('flush() espera al guardado en curso', async () => {
    const blob = blobFalso();
    const log = servicio(blob);

    log.push('gupshup', 'Evento recibido (gupshup:message)');

    const esperando = log.flush();
    expect(blob.escrituras).toHaveLength(0); // todavía no se guardó nada

    await blob.completar();
    await esperando;

    expect(blob.escrituras).toHaveLength(1);
    expect(blob.escrituras[0]).toContain('gupshup:message');
  });

  it('encadena los guardados: dos eventos seguidos no se pisan', async () => {
    const blob = blobFalso();
    const log = servicio(blob);

    log.push('gupshup', 'primero');
    log.push('gupshup', 'segundo');

    const esperando = log.flush();
    // Encadenados, no en paralelo: el segundo no arranca hasta soltar el primero.
    await blob.completar();
    await blob.completar();
    await esperando;

    expect(blob.escrituras).toHaveLength(2);
    // El último guardado lleva los dos eventos: no se perdió ninguno.
    expect(blob.escrituras[1]).toContain('primero');
    expect(blob.escrituras[1]).toContain('segundo');
  });

  it('sin nada agendado, flush() no bloquea', async () => {
    const blob = blobFalso();
    const log = servicio(blob);
    // Nunca se llama a `completar`: si flush() esperara algo, esto colgaría.
    await log.flush();
    expect(blob.escrituras).toHaveLength(0);
  });
});
