import * as os from 'os';
import * as path from 'path';
import { JsonBrainRepository } from './brain.repository.json';
import { digitosDe, mismoTelefono } from './telefono';

/**
 * El teléfono es la llave de identidad de toda la app, y cada canal lo
 * escribe distinto: NL Pearl manda `50494882705`, Gupshup `+50494882705`.
 * Con igualdad exacta el mismo ciudadano terminaba como DOS contactos y su
 * conversación se partía en dos hilos.
 */
describe('Identidad por teléfono', () => {
  it('reconoce el mismo número escrito de cualquier forma', () => {
    expect(mismoTelefono('50494882705', '+50494882705')).toBe(true);
    expect(mismoTelefono('+504 9488-2705', '50494882705')).toBe(true);
    expect(mismoTelefono('(504) 9488 2705', '+50494882705')).toBe(true);
  });

  it('no confunde números distintos', () => {
    expect(mismoTelefono('50494882705', '50497616546')).toBe(false);
  });

  it('un vacío nunca es igual a nada, ni a otro vacío', () => {
    expect(mismoTelefono('', '')).toBe(false);
    expect(mismoTelefono(undefined, '50494882705')).toBe(false);
    expect(mismoTelefono('---', '50494882705')).toBe(false);
    expect(digitosDe(null)).toBe('');
  });

  /*
   * La prueba que importa: el repositorio real. Es donde vivía el bug, y es
   * lo que decide si una respuesta cae en el hilo abierto o inventa uno.
   */
  it('el repositorio encuentra al contacto aunque el formato no calce', async () => {
    // Archivo propio: con el de desarrollo, la prueba encontraba contactos
    // reales que ya tenían ese número y no probaba nada.
    const archivo = path.join(os.tmpdir(), `brain-test-${process.pid}-${Date.now()}.json`);
    const repo = new JsonBrainRepository({
      get: (k: string, def?: unknown) => (k === 'BRAIN_DATA_FILE' ? archivo : def),
    } as never);
    // Guardado como lo deja NL Pearl: sin el +.
    await repo.saveContact({
      id: 'c1',
      displayName: 'Yuni',
      phones: ['50494882705'],
      externalIds: {},
    });

    // Consultado como lo manda Gupshup: con el +.
    const hallado = await repo.findContactByPhone('+50494882705');

    expect(hallado?.id).toBe('c1');
  });
});
