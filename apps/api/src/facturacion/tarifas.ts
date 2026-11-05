import { GrupoPais, grupoDe } from './paises';

/**
 * Cuánto se cobra por un mensaje: la tarifa.
 *
 * Hive vende dos cosas y hay que separarlas: el AGENTE —que se cobra por
 * mes, en el plan— y los MENSAJES que el agente manda, que se cobran por
 * unidad. Mezclarlas en un precio plano suena simple y es la forma más
 * rápida de perder plata: el cliente que manda cincuenta mil mensajes paga
 * lo mismo que el que manda doscientos.
 *
 * El precio depende de dos cosas:
 *
 *  1. El PAÍS de destino. WhatsApp cobra por país y la diferencia es de
 *     varias veces, no de centavos.
 *  2. La CATEGORÍA. Contestarle a alguien que escribió hace diez minutos no
 *     cuesta lo mismo que iniciarle una conversación mañana: eso último
 *     exige una plantilla aprobada y WhatsApp lo cobra aparte.
 *
 * Todo en MICRODÓLARES enteros (1 USD = 1 000 000). En centavos no alcanza
 * la precisión —una tarifa real es 0,0405 USD— y en coma flotante la suma de
 * cincuenta mil mensajes termina con un resto que no cuadra con la factura.
 */

/**
 * La categoría del mensaje, con los nombres de WhatsApp.
 *
 * - `servicio`: respuesta dentro de la ventana de 24 h que abrió la persona.
 *   Es el caso normal del agente y el más barato.
 * - `utilidad`: algo que el cliente espera —un recordatorio de cita, el
 *   avance de su reporte— fuera de esa ventana. Exige plantilla aprobada.
 * - `autenticacion`: códigos de acceso.
 * - `marketing`: lo que nadie pidió. El más caro, y el que puede quemar el
 *   presupuesto de un cliente en una tarde.
 */
export type Categoria = 'servicio' | 'utilidad' | 'autenticacion' | 'marketing';

export const CATEGORIAS: Categoria[] = ['servicio', 'utilidad', 'autenticacion', 'marketing'];

export const NOMBRE_CATEGORIA: Record<Categoria, string> = {
  servicio: 'Respuesta',
  utilidad: 'Aviso útil',
  autenticacion: 'Código',
  marketing: 'Promoción',
};

/** Precio de venta por grupo de país, en microdólares por mensaje. */
export type Precios = Record<Categoria, number>;

/**
 * La tarifa de salida.
 *
 * OJO: estos números son el punto de partida comercial, no la tarifa de
 * WhatsApp. El costo real lo publica Meta por país y cambia; antes de
 * facturarle a un cliente de verdad hay que contrastarlos y ajustarlos
 * desde la consola. Están acá para que el sistema no nazca sin precio —un
 * cero por defecto sería regalar los mensajes— y se pueden sobrescribir por
 * organización sin tocar código.
 */
const POR_GRUPO: Record<GrupoPais, Precios> = {
  centroamerica: { servicio: 25_000, utilidad: 40_000, autenticacion: 40_000, marketing: 80_000 },
  mexico: { servicio: 20_000, utilidad: 35_000, autenticacion: 35_000, marketing: 60_000 },
  norteamerica: { servicio: 15_000, utilidad: 30_000, autenticacion: 30_000, marketing: 30_000 },
  sudamerica: { servicio: 30_000, utilidad: 50_000, autenticacion: 50_000, marketing: 100_000 },
  caribe: { servicio: 35_000, utilidad: 60_000, autenticacion: 60_000, marketing: 110_000 },
  europa: { servicio: 40_000, utilidad: 70_000, autenticacion: 70_000, marketing: 140_000 },
  resto: { servicio: 50_000, utilidad: 90_000, autenticacion: 90_000, marketing: 150_000 },
};

/**
 * Lo que un cliente negoció para sí.
 *
 * Las claves son ISO de país o nombres de grupo; lo más específico gana. Un
 * cliente que manda medio millón de mensajes a Honduras consigue precio por
 * Honduras, y eso no puede obligar a tocar la tarifa de todos.
 */
export interface TarifaOrg {
  /** Por país: `{ HN: { servicio: 18000 } }`. Parcial: lo que no está, hereda. */
  paises?: Record<string, Partial<Precios>>;
  /** Por grupo: `{ centroamerica: { marketing: 70000 } }`. */
  grupos?: Partial<Record<GrupoPais, Partial<Precios>>>;
}

/**
 * El precio de UN mensaje a este país en esta categoría.
 *
 * El orden es de lo específico a lo general: país negociado, grupo
 * negociado, grupo de la tarifa base. Nunca devuelve cero por no encontrar
 * nada — un cero silencioso es un mensaje gratis que nadie nota hasta fin
 * de mes.
 */
export function precioDe(iso: string, categoria: Categoria, negociada?: TarifaOrg): number {
  const grupo = grupoDe(iso);
  return (
    negociada?.paises?.[iso]?.[categoria] ??
    negociada?.grupos?.[grupo]?.[categoria] ??
    POR_GRUPO[grupo][categoria]
  );
}

/** La tarifa base de un grupo, para mostrarla en la consola. */
export function tarifaDe(grupo: GrupoPais): Precios {
  return POR_GRUPO[grupo];
}

export function tarifaBase(): Record<GrupoPais, Precios> {
  return POR_GRUPO;
}

/** Microdólares → «US$ 1.23». Lo que se imprime en la factura. */
export function enDolares(micros: number): string {
  return `US$ ${(micros / 1_000_000).toFixed(2)}`;
}
