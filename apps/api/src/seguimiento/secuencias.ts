import { Categoria } from '../facturacion/tarifas';

/**
 * Las secuencias de seguimiento: lo que el agente manda SIN que le escriban.
 *
 * Es la otra mitad del producto. Hasta acá el agente contestaba: alguien
 * escribía y él respondía. Un seguimiento es al revés —nosotros empezamos— y
 * eso cambia tres cosas a la vez:
 *
 *  1. Es lo que hace que el agente trabaje cuando nadie lo mira. El lead que
 *     preguntó un viernes y nadie llamó se recupera el lunes solo.
 *  2. Cuesta más. Fuera de la ventana de 24 h WhatsApp exige una plantilla
 *     aprobada y la cobra como «utilidad», no como respuesta.
 *  3. Es lo único de Hive que puede molestar de verdad. Un agente que
 *     contesta mal es un agente malo; un agente que escribe tres veces sin
 *     que nadie le pregunte es acoso, y lo bloquean.
 *
 * Por eso cada secuencia es CORTA, se corta sola en cuanto la persona
 * contesta, y lo que cuesta se dice antes de encenderla.
 *
 * Las secuencias van por TIPO DE AGENTE y no una sola para todos: lo que un
 * agente de citas tiene que recordar no se parece a lo que un agente de
 * ventas tiene que insistir. Un seguimiento genérico —«¿seguimos en
 * contacto?»— es el que nadie contesta.
 */

export interface PasoSeguimiento {
  id: string;
  /**
   * Cuántas horas desde el momento de referencia. NEGATIVO es antes.
   *
   * La referencia es la inscripción, salvo que se inscriba con una fecha
   * —la de la cita— y entonces es esa. Sin poder contar hacia atrás, un
   * recordatorio de cita habría que calcularlo afuera, y el único lugar
   * donde se puede calcular bien es acá.
   */
  horas: number;
  /** El texto. Lleva {nombre}, {negocio} y {agente}. */
  texto: string;
  categoria: Categoria;
  /** Qué se espera que haga la persona, para la pantalla. */
  intencion: string;
}

export interface SecuenciaSeguimiento {
  id: string;
  nombre: string;
  /** Para qué sirve, en una línea. */
  resumen: string;
  /** Los tipos de agente donde tiene sentido (ids de `plantillas.ts`). */
  paraPlantillas: string[];
  /** Cuándo se inscribe a alguien, en palabras del negocio. */
  disparador: string;
  /**
   * ¿Se inscribe sola cuando el agente termina de atender?
   *
   * Las que van en false necesitan un dato que la conversación no tiene
   * —la fecha de la cita— y se inscriben desde el flujo del agente o a
   * mano. Encenderlas «solas» sin ese dato mandaría el recordatorio en el
   * momento equivocado, que es peor que no mandarlo.
   */
  automatica: boolean;
  pasos: PasoSeguimiento[];
}

const SECUENCIAS: SecuenciaSeguimiento[] = [
  {
    id: 'lead-sin-respuesta',
    nombre: 'Lead que no volvió',
    resumen: 'Rescata a quien preguntó por un precio y no contestó más.',
    paraPlantillas: ['ventas'],
    disparador: 'Alguien preguntó algo comercial y dejó de contestar.',
    automatica: true,
    pasos: [
      {
        id: 'mismo-dia',
        horas: 3,
        texto: 'Hola {nombre}, te quedó pendiente lo que consultaste en {negocio}. ¿Te sigue interesando?',
        categoria: 'servicio',
        intencion: 'Que retome la conversación el mismo día, cuando todavía se acuerda.',
      },
      {
        id: 'al-dia-siguiente',
        horas: 26,
        texto: 'Hola {nombre}, soy {agente} de {negocio}. ¿Querés que te pase los detalles o preferís que te llamemos?',
        categoria: 'utilidad',
        intencion: 'Darle una salida fácil: contestar o pedir una llamada.',
      },
      {
        id: 'ultimo',
        horas: 72,
        texto:
          'Hola {nombre}, te escribo por última vez desde {negocio}. Si más adelante lo necesitás, acá estamos.',
        categoria: 'utilidad',
        /*
         * El tercero dice que es el último y de verdad lo es. Decirlo tiene
         * dos efectos: el que iba a contestar contesta, y el que no, no se
         * queda esperando que sigamos escribiéndole.
         */
        intencion: 'Cerrar sin dejar la puerta golpeando. Es el último, y lo dice.',
      },
    ],
  },
  {
    id: 'recordatorio-cita',
    nombre: 'Recordatorio de cita',
    resumen: 'Avisa el día antes y un rato antes, y pregunta después cómo fue.',
    paraPlantillas: ['citas'],
    disparador: 'Se agendó una cita. Los avisos se cuentan desde la hora de la cita.',
    automatica: false,
    pasos: [
      {
        id: 'dia-antes',
        horas: -24,
        texto: 'Hola {nombre}, te recordamos tu cita en {negocio} mañana. ¿La confirmás o la movemos?',
        categoria: 'utilidad',
        intencion: 'Confirmar o reprogramar con tiempo. Es el paso que evita el asiento vacío.',
      },
      {
        id: 'horas-antes',
        horas: -3,
        texto: 'Hola {nombre}, tu cita en {negocio} es en un rato. Te esperamos.',
        categoria: 'utilidad',
        intencion: 'Que no se olvide el mismo día.',
      },
      {
        id: 'despues',
        horas: 4,
        texto: 'Hola {nombre}, ¿cómo te fue en {negocio}? Si quedó algo pendiente, contame.',
        categoria: 'servicio',
        intencion: 'Abrir la puerta a un reclamo antes de que se convierta en una reseña.',
      },
    ],
  },
  {
    id: 'avance-reporte',
    nombre: 'Avance del reporte',
    resumen: 'Le dice al vecino que su reporte sigue vivo, sin prometer fecha.',
    paraPlantillas: ['reportes'],
    disparador: 'Se registró un reporte y quedó en seguimiento.',
    automatica: true,
    pasos: [
      {
        id: 'al-dia',
        horas: 24,
        texto: 'Hola {nombre}, tu reporte en {negocio} sigue en seguimiento. Te avisamos cuando haya novedad.',
        categoria: 'utilidad',
        /*
         * No promete fecha a propósito. Un «se resuelve esta semana» que no
         * se cumple es peor que el silencio: la próxima vez no le creen a
         * nada de lo que diga el agente.
         */
        intencion: 'Que sepa que no se perdió. Sin fecha, porque no la tenemos.',
      },
      {
        id: 'a-la-semana',
        horas: 168,
        texto: 'Hola {nombre}, pasó una semana de tu reporte en {negocio}. ¿Sigue el problema igual?',
        categoria: 'utilidad',
        intencion: 'Saber si ya se resolvió sin que nadie lo anotara, que pasa seguido.',
      },
    ],
  },
  {
    id: 'como-fue',
    nombre: 'Cómo quedó tu trámite',
    resumen: 'Pregunta una vez si quedó resuelto. Una sola, y se calla.',
    paraPlantillas: ['postventa', 'recepcionista'],
    disparador: 'El agente cerró una conversación sin pasarla a una persona.',
    automatica: true,
    pasos: [
      {
        id: 'unico',
        horas: 20,
        texto: 'Hola {nombre}, ¿te quedó resuelto lo de ayer en {negocio}? Si no, decímelo y lo retomamos.',
        categoria: 'servicio',
        intencion: 'Cazar lo que quedó a medias. Un solo mensaje: si no contesta, listo.',
      },
    ],
  },
];

export function secuencias(): SecuenciaSeguimiento[] {
  return SECUENCIAS;
}

export function secuencia(id: string): SecuenciaSeguimiento | undefined {
  return SECUENCIAS.find((s) => s.id === id);
}

/** Las que corresponden a un tipo de agente. */
export function secuenciasDe(plantilla?: string): SecuenciaSeguimiento[] {
  if (!plantilla) return [];
  return SECUENCIAS.filter((s) => s.paraPlantillas.includes(plantilla));
}

/**
 * Arma el texto con los datos de la persona.
 *
 * Sin nombre queda «Hola, …» y no «Hola {nombre}»: un hueco sin rellenar en
 * un WhatsApp real es lo que delata que atrás no hay nadie.
 */
export function redactar(
  texto: string,
  datos: { nombre?: string; negocio: string; agente?: string },
): string {
  return (
    texto
      .replace(/\{nombre\}/g, datos.nombre?.trim() || '')
      .replace(/\{negocio\}/g, datos.negocio)
      .replace(/\{agente\}/g, datos.agente?.trim() || 'el asistente')
      // «Hola , ¿cómo…» — el espacio que deja el nombre ausente delante de
      // la coma es justo lo que se ve raro en el teléfono.
      .replace(/\s+([,.;!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
