/**
 * Sondeo adaptativo para las vistas que se refrescan solas.
 *
 * Antes cada pantalla tenía su `setInterval` a ritmo fijo y agresivo (el hilo
 * abierto recargaba cada 1,2 s). Con varias pestañas abiertas eso se
 * multiplicaba: se llegaron a medir ~8 peticiones por segundo contra la API,
 * que además de gastar invocaciones dejaba los logs del servidor ilegibles
 * para diagnosticar cualquier otra cosa.
 *
 * Acá el intervalo ARRANCA rápido y se va estirando mientras el contenido no
 * cambie, hasta un techo. Cualquier cambio —o que vuelvas a la pestaña— lo
 * devuelve al ritmo rápido, así se sigue sintiendo vivo cuando algo pasa y se
 * calla cuando no. Se usa `setTimeout` encadenado en vez de `setInterval`
 * porque la espera es variable, y nunca se solapan dos vueltas.
 */
export interface SondeoOpts {
  /** Espera inicial y tras cada cambio, en ms. */
  base: number;
  /** Techo al que llega estirándose, en ms. */
  max: number;
  /** Dispara la recarga. */
  alSondear: () => void;
  /**
   * Firma barata del estado actual (p. ej. cantidad + fecha del último
   * mensaje). Si entre vueltas no cambia, el intervalo se estira.
   */
  firma: () => string | undefined;
  /** Si devuelve false se saltea la vuelta sin gastar la petición. */
  activo?: () => boolean;
}

/** El sondeo en marcha: se detiene, y se le puede pedir que acelere. */
export interface Sondeo {
  detener: () => void;
  /**
   * Volver al ritmo rápido AHORA.
   *
   * La firma sube el ritmo cuando algo YA cambió, pero hay momentos en que
   * sabemos que está por cambiar y todavía no: al mandar un mensaje, la
   * respuesta llega en segundos y el sondeo podía estar estirado a 20 s. Sin
   * esto, el operador escribía y veía la respuesta veinte segundos tarde.
   */
  reactivar: () => void;
}

/** Arranca el sondeo. */
export function crearSondeo(opts: SondeoOpts): Sondeo {
  let espera = opts.base;
  let timer: ReturnType<typeof setTimeout>;
  let vivo = true;

  // La firma NO se lee al arrancar: `crearSondeo` se llama desde el constructor
  // del componente, cuando los inputs requeridos todavía no están ligados y
  // tocar el recurso lanza NG0950. Se lee recién en la primera vuelta.
  let ultimaFirma: string | undefined;

  /** Nunca debe tumbar el sondeo: si el recurso aún no está listo, sin firma. */
  const firmaSegura = (): string | undefined => {
    try {
      return opts.firma();
    } catch {
      return undefined;
    }
  };

  const programar = () => {
    if (!vivo) return;
    timer = setTimeout(vuelta, espera);
  };

  const vuelta = () => {
    if (!vivo) return;

    // Pestaña oculta o vista ocupada: ni se pide ni se penaliza el ritmo.
    if (document.visibilityState !== 'visible' || opts.activo?.() === false) {
      programar();
      return;
    }

    const firma = firmaSegura();
    if (firma !== ultimaFirma) {
      ultimaFirma = firma;
      espera = opts.base; // algo pasó: volvemos al ritmo rápido
    } else {
      espera = Math.min(Math.round(espera * 1.6), opts.max);
    }

    opts.alSondear();
    programar();
  };

  // Al volver a la pestaña se retoma el ritmo rápido de inmediato.
  const alVolver = () => {
    if (document.visibilityState !== 'visible') return;
    espera = opts.base;
    clearTimeout(timer);
    vuelta();
  };
  document.addEventListener('visibilitychange', alVolver);

  programar();

  return {
    detener: () => {
      vivo = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', alVolver);
    },
    reactivar: () => {
      if (!vivo) return;
      espera = opts.base;
      clearTimeout(timer);
      programar();
    },
  };
}
