import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Que ningún campo de una interacción se pierda al guardarla en Postgres.
 *
 * Pasó con `ficha`: el INSERT de Postgres lista las columnas una por una, se
 * agregó el campo al tipo y a todo lo demás, y ahí quedó descartado en
 * SILENCIO. Local no se notaba —los repositorios de archivo y de Blob guardan
 * el objeto entero— y en producción, que es la única que usa Postgres, el riel
 * derecho se quedaba con el dato viejo: el estado emocional decía "Neutral"
 * para siempre.
 *
 * No hay forma de que un tipo de TypeScript obligue a tocar un string de SQL,
 * así que se cruzan acá. Es estático a propósito: una prueba contra una base
 * real no correría en CI y esto tiene que fallar antes de desplegar.
 */
describe('Interaction · nada se pierde al persistir', () => {
  const dir = __dirname;
  const tipos = readFileSync(join(dir, 'types.ts'), 'utf8');
  const pg = readFileSync(join(dir, 'brain.repository.pg.ts'), 'utf8');

  /** Los campos declarados en `interface Interaction`. */
  const campos = (): string[] => {
    const bloque = /export interface Interaction \{([\s\S]*?)\n\}/.exec(tipos);
    if (!bloque) throw new Error('No encontré la interfaz Interaction en types.ts');
    return [...bloque[1].matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
  };

  /** De `attachmentUrl` a `attachment_url`: así se llaman las columnas. */
  const aColumna = (campo: string) => campo.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  it('cada campo de la interfaz tiene su columna en el INSERT', () => {
    const insert = /INSERT INTO interactions \(([^)]+)\)/.exec(pg);
    expect(insert).not.toBeNull();
    const columnas = insert![1].split(',').map((c) => c.trim());

    const faltantes = campos().filter((c) => !columnas.includes(aColumna(c)));
    expect(faltantes).toEqual([]);
  });

  it('cada campo se vuelve a leer al hidratar la interacción', () => {
    /*
     * Guardar y no leer es el mismo bug con otra cara: el dato queda en la
     * base y la app se comporta como si no existiera.
     */
    const faltantes = campos().filter(
      (c) => !new RegExp(`\\b${c}:\\s*\\(?r\\[`).test(pg) && !new RegExp(`\\b${c}:`).test(pg),
    );
    expect(faltantes).toEqual([]);
  });

  it('la columna existe en el esquema', () => {
    // Un INSERT que nombra una columna inexistente falla en la primera
    // escritura de producción, no acá.
    const esquema = readFileSync(join(dir, '..', 'shared', 'database.module.ts'), 'utf8');
    const insert = /INSERT INTO interactions \(([^)]+)\)/.exec(pg)!;
    const columnas = insert[1].split(',').map((c) => c.trim());

    const sinDeclarar = columnas.filter(
      (c) => !new RegExp(`\\b${c}\\b`).test(esquema.slice(esquema.indexOf('CREATE TABLE IF NOT EXISTS interactions'))),
    );
    expect(sinDeclarar).toEqual([]);
  });
});
