import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgenteToolsService } from './agente-tools.service';

/**
 * Que lo que se le declara al agente sea lo que el backend sabe ejecutar.
 *
 * Son dos archivos que nadie edita junto: el script que provisiona las
 * herramientas en ElevenLabs y el servicio que las corre. Si se separan, el
 * fallo es MUDO —el agente cree que llamó la herramienta, le inventa un folio
 * al ciudadano y en el hilo no queda nada—, así que no hay forma de notarlo
 * mirando la consola. Esta prueba es el único lugar donde se cruzan.
 */
describe('Declaración de herramientas en ElevenLabs', () => {
  const RAIZ = join(__dirname, '..', '..', '..', '..');
  const script = readFileSync(join(RAIZ, 'scripts/elevenlabs-setup.mjs'), 'utf8');
  const servicio = readFileSync(join(__dirname, 'agente-tools.service.ts'), 'utf8');

  it('declara exactamente las herramientas que el servicio ejecuta', () => {
    const declaradas = [...script.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);

    expect(declaradas.sort()).toEqual([...AgenteToolsService.NOMBRES].sort());
  });

  /** Lo que el script le pide al agente que mande, herramienta por herramienta. */
  function declaradosPorHerramienta(): Map<string, Set<string>> {
    const porNombre = new Map<string, Set<string>>();
    for (const bloque of script.split(/^ {4}name: '/m).slice(1)) {
      const nombre = bloque.slice(0, bloque.indexOf("'"));
      const props = bloque.slice(bloque.indexOf('props: {'), bloque.indexOf('\n    },'));
      porNombre.set(nombre, new Set([...props.matchAll(/^ {6}([a-z_]+): \[/gm)].map((m) => m[1])));
    }
    return porNombre;
  }

  /** Lo que el servicio saca del payload, herramienta por herramienta. */
  function leidosPorHerramienta(): Map<string, Set<string>> {
    const porNombre = new Map<string, Set<string>>();
    // El switch de `ejecutar` es lo que une el nombre público con el método.
    const despacho = servicio.matchAll(/case '([a-z_]+)':\s*\n\s*return await this\.(\w+)\(/g);
    for (const [, nombre, metodo] of despacho) {
      const desde = servicio.indexOf(`private async ${metodo}(`);
      const resto = servicio.slice(desde);
      // El cuerpo llega hasta donde arranca el siguiente método de la clase.
      const hasta = resto.indexOf('\n  private ', 1);
      const cuerpo = hasta === -1 ? resto : resto.slice(0, hasta);
      porNombre.set(nombre, new Set([...cuerpo.matchAll(/args\['([a-z_]+)'\]/g)].map((m) => m[1])));
    }
    return porNombre;
  }

  it('declara, en CADA herramienta, los parámetros que esa herramienta lee', () => {
    const declarados = declaradosPorHerramienta();
    const leidos = leidosPorHerramienta();

    // Si el parseo falla, los dos mapas quedan vacíos y la prueba pasaría sola.
    expect([...leidos.keys()].sort()).toEqual([...AgenteToolsService.NOMBRES].sort());
    expect([...declarados.keys()].sort()).toEqual([...AgenteToolsService.NOMBRES].sort());

    /*
     * Por herramienta y no en bolsa: `ubicacion` existe en dos, y comparando
     * todo junto un cambio de nombre en una quedaba tapado por la otra. El
     * parámetro llegaría siempre vacío y el ticket saldría sin ubicación.
     */
    const faltantes: string[] = [];
    for (const [nombre, params] of leidos) {
      for (const p of params) {
        if (!declarados.get(nombre)?.has(p)) faltantes.push(`${nombre}.${p}`);
      }
    }
    expect(faltantes).toEqual([]);
  });

  it('espera la respuesta de todas: sin eso el agente pierde el folio', () => {
    /*
     * `expects_response` es el "Esperar respuesta" del panel. Apagado, el
     * agente dispara la herramienta y sigue hablando sin leer lo que devolvió
     * —justo el número de seguimiento y la lista de responsables que tiene que
     * decirle al ciudadano—.
     */
    expect(script).toContain('expects_response: true');
    expect(script).not.toContain('expects_response: false');
  });
});
