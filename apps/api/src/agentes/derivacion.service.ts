import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { orgActual } from '../shared/contexto-org';
import { SettingsService } from '../shared/settings.service';

/**
 * Cambio de agente: qué hace Hive cuando alguien le escribe a un agente
 * sobre un tema que es de otro.
 *
 * Sin esto, el vecino que le escribe a Aseo 100 por un bache recibe una
 * respuesta de aseo o un «no es mi tema» — y se va. El cambio resuelve eso
 * sin pedirle que repita nada ni que busque otro número.
 *
 * La decisión es del cliente y no nuestra: hay negocios donde cambiar solo
 * es lo correcto y otros donde tocar la conversación sin avisar es
 * inaceptable. Por eso hay tres modos y no un comportamiento fijo.
 */

export type ModoDerivacion = 'automatico' | 'preguntar' | 'nunca';

export interface ReglaDerivacion {
  id: string;
  /** El tema, en palabras del negocio: «Baches, obras y postes». */
  tema: string;
  /** A qué agente va. Referencia del proveedor; la consola muestra su nombre. */
  agente: string;
  activa: boolean;
  /** Cuántas veces se aplicó este mes. Lo lleva el motor, no se edita. */
  cambios: number;
}

export interface ConfigDerivacion {
  modo: ModoDerivacion;
  /**
   * Cuán seguro tiene que estar para cambiar solo, 70–100.
   *
   * Por debajo pregunta; por debajo de 70 no cambia ni preguntando. Ese
   * piso no se configura a propósito: con menos certeza que eso, «cambiar»
   * es adivinar, y adivinar mandando a alguien con otro agente es peor que
   * no hacer nada.
   */
  umbral: number;
  /** Lo que se le dice al ciudadano. Lleva {agente}, {tema} y {ciudadano}. */
  mensaje: string;
  reglas: ReglaDerivacion[];
}

/** El piso duro: por debajo de esto no se cambia, lo diga quien lo diga. */
export const UMBRAL_MINIMO = 70;

const POR_DEFECTO: ConfigDerivacion = {
  modo: 'automatico',
  umbral: 90,
  mensaje: 'Eso lo atiende {agente}, te paso con ese agente. No tenés que repetir nada.',
  reglas: [],
};

@Injectable()
export class DerivacionService {
  private readonly logger = new Logger(DerivacionService.name);

  constructor(private readonly settings: SettingsService) {}

  /** La clave es por organización: cada empresa tiene sus reglas. */
  private clave(org?: string): string {
    return `derivacion:${org ?? orgActual() ?? 'sin-organizacion'}`;
  }

  async leer(org?: string): Promise<ConfigDerivacion> {
    const guardado = await this.settings.get<Partial<ConfigDerivacion>>(this.clave(org));
    return {
      ...POR_DEFECTO,
      ...(guardado ?? {}),
      // El piso se aplica al LEER y no solo al guardar: una configuración
      // escrita antes de que existiera el piso no puede saltárselo.
      umbral: Math.max(UMBRAL_MINIMO, guardado?.umbral ?? POR_DEFECTO.umbral),
      reglas: guardado?.reglas ?? [],
    };
  }

  async guardar(cambios: Partial<ConfigDerivacion>, org?: string): Promise<ConfigDerivacion> {
    const actual = await this.leer(org);
    const nueva: ConfigDerivacion = {
      ...actual,
      ...cambios,
      umbral: Math.min(100, Math.max(UMBRAL_MINIMO, cambios.umbral ?? actual.umbral)),
      // Los contadores los lleva el motor: si vinieran del cliente, el
      // panel de «cambios este mes» diría lo que el navegador quiera.
      reglas: (cambios.reglas ?? actual.reglas).map((r) => ({
        ...r,
        id: r.id || randomUUID(),
        cambios: actual.reglas.find((v) => v.id === r.id)?.cambios ?? 0,
      })),
    };
    await this.settings.set(this.clave(org), nueva);
    this.logger.log(`Derivación guardada: modo ${nueva.modo}, umbral ${nueva.umbral}%`);
    return nueva;
  }

  /**
   * ¿Este mensaje es tema de otro agente?
   *
   * El emparejado es por palabras del tema y no por un modelo: una llamada
   * a un LLM por cada mensaje entrante suma latencia y costo al camino más
   * caliente de la app, y el tema de una regla («Baches, obras y postes»)
   * ya trae las palabras con las que la gente lo nombra. Cuando esto se
   * quede corto se le pone un clasificador detrás, pero el contrato —texto
   * entra, decisión sale— no cambia.
   *
   * La confianza es qué proporción de las palabras del tema aparecieron: si
   * la regla dice «baches, obras y postes» y el mensaje solo dice «poste»,
   * es una pista, no una certeza.
   */
  async decidir(
    texto: string,
    agenteActual: string,
    org?: string,
  ): Promise<{ agente: string; tema: string; confianza: number; accion: 'cambiar' | 'preguntar' } | null> {
    const config = await this.leer(org);
    if (config.modo === 'nunca') return null;

    const limpio = DerivacionService.normalizar(texto);
    if (!limpio) return null;

    let mejor: { regla: ReglaDerivacion; confianza: number } | null = null;

    for (const regla of config.reglas) {
      if (!regla.activa || regla.agente === agenteActual) continue;

      const palabras = DerivacionService.palabrasDe(regla.tema);
      if (!palabras.length) continue;

      const halladas = palabras.filter((p) => DerivacionService.aparece(p, limpio));
      if (!halladas.length) continue;

      const confianza = Math.round((halladas.length / palabras.length) * 100);
      if (!mejor || confianza > mejor.confianza) mejor = { regla, confianza };
    }

    if (!mejor || mejor.confianza < UMBRAL_MINIMO) return null;

    /*
     * Por encima del umbral cambia; entre el piso y el umbral, pregunta. En
     * modo «preguntar» nunca cambia solo, por alto que sea el número: el
     * cliente pidió que la persona confirme, y un porcentaje no revoca eso.
     */
    const accion: 'cambiar' | 'preguntar' =
      config.modo === 'preguntar' || mejor.confianza < config.umbral ? 'preguntar' : 'cambiar';

    return { agente: mejor.regla.agente, tema: mejor.regla.tema, confianza: mejor.confianza, accion };
  }

  /** Suma uno al contador de la regla que se aplicó. */
  async anotarCambio(agenteDestino: string, org?: string): Promise<void> {
    const config = await this.leer(org);
    const reglas = config.reglas.map((r) =>
      r.agente === agenteDestino ? { ...r, cambios: r.cambios + 1 } : r,
    );
    await this.settings.set(this.clave(org), { ...config, reglas });
  }

  /** El mensaje al ciudadano, con sus variables puestas. */
  static redactar(plantilla: string, datos: { agente: string; tema: string; ciudadano: string }): string {
    return plantilla
      .replace(/\{agente\}/g, datos.agente)
      .replace(/\{tema\}/g, datos.tema.toLowerCase())
      .replace(/\{ciudadano\}/g, datos.ciudadano);
  }

  /**
   * ¿La palabra del tema está en el mensaje, aunque esté en singular?
   *
   * Los temas se escriben en plural —«Baches, obras y postes»— y la gente
   * reporta en singular: «hay un bache». Comparando literal, el caso más
   * común de todos no emparejaba y la derivación no ocurría nunca. Lo
   * encontró un test, no la lectura.
   *
   * Se compara contra la RAÍZ, quitando el plural de los dos lados. No es
   * un lematizador: alcanza para el español de un tema de negocio, y
   * equivocarse acá solo cuesta una derivación de menos.
   */
  private static aparece(palabra: string, texto: string): boolean {
    const raiz = DerivacionService.raiz(palabra);
    // Con límite de palabra: «agua» no debe emparejar dentro de «aguantar».
    return new RegExp(`\\b${raiz}(es|s)?\\b`, 'i').test(texto);
  }

  /**
   * «baches» → «bache»; «fugas» → «fuga».
   *
   * Solo se quita la ese final. Quitar «es» entero —que parece la regla del
   * plural— convierte «baches» en «bach» y «postes» en «post», y entonces
   * no empareja ni con el singular ni con el plural: la derivación no
   * ocurría nunca. Es el bug que encontró el test del caso más común.
   *
   * Un plural como «árboles» queda en «árbole» y no empareja con el
   * singular. Se acepta: el costo es una derivación de menos, y un
   * lematizador de verdad es mucho aparato para los temas de un negocio.
   */
  private static raiz(p: string): string {
    return p.length > 3 && p.endsWith('s') ? p.slice(0, -1) : p;
  }

  /** Sin tildes y en minúsculas: «bachés» y «baches» son la misma palabra. */
  private static normalizar(t: string): string {
    return t
      .toLowerCase()
      .normalize('NFD')
      // El rango de diacríticos combinantes, escrito con escapes: pegado
      // literal se corrompe al pasar por un editor y deja de limpiar nada.
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Las palabras con peso del tema.
   *
   * Se tiran las de menos de cuatro letras y las de unión: con «y» o «de»
   * adentro, cualquier mensaje emparejaría con cualquier regla.
   */
  private static palabrasDe(tema: string): string[] {
    const UNION = new Set(['para', 'como', 'sobre', 'entre', 'desde', 'hasta']);
    return DerivacionService.normalizar(tema)
      .split(/[\s,·/]+/)
      .map((p) => p.replace(/[^\wñ]/g, ''))
      .filter((p) => p.length >= 4 && !UNION.has(p));
  }
}
