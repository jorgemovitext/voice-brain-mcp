import { Mercado, mercadoDe } from './paises';

/**
 * Por dónde sale el mensaje.
 *
 * Hoy solo WhatsApp, pero el precio y el costo son POR CANAL: un SMS a
 * Honduras no vale lo que un WhatsApp a Honduras. Está en la llave de la
 * tarifa desde ahora porque agregarlo después obliga a migrar cada fila de
 * facturación ya emitida — y esas filas no se pueden recalcular, llevan su
 * precio congelado.
 */
export type CanalCobrable = 'whatsapp' | 'sms' | 'voz';

export const CANALES: CanalCobrable[] = ['whatsapp', 'sms', 'voz'];

export const NOMBRE_CANAL: Record<CanalCobrable, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  voz: 'Voz',
};

/** Un canal que no reconocemos se cobra como WhatsApp, que es lo que hay. */
export function canalValido(canal?: string): CanalCobrable {
  return canal === 'sms' || canal === 'voz' ? canal : 'whatsapp';
}

/**
 * Lo que un mensaje nos CUESTA y lo que lo COBRAMOS.
 *
 * Hive vende dos cosas y hay que separarlas: el AGENTE —que se cobra por
 * mes, en el plan— y los MENSAJES que manda, que se cobran por unidad.
 * Mezclarlas en un precio plano suena simple y es la forma más rápida de
 * perder plata: el cliente que manda cincuenta mil mensajes paga lo mismo
 * que el que manda doscientos.
 *
 * El precio depende de dos cosas:
 *
 *  1. El MERCADO del destinatario. Meta cobra por el código de marcación de
 *     quien recibe, y la diferencia entre mercados es de varias veces.
 *  2. La CATEGORÍA. Contestarle a alguien que escribió hace diez minutos no
 *     cuesta lo mismo que iniciarle una conversación mañana: eso último
 *     exige una plantilla aprobada y Meta lo cobra aparte.
 *
 * Todo en MICRODÓLARES enteros (1 USD = 1 000 000). En centavos no alcanza
 * la precisión —la tarifa de India son 0,0014 USD— y en coma flotante la
 * suma de cincuenta mil mensajes termina con un resto que no cuadra con la
 * factura.
 */

/**
 * La categoría del mensaje, con los nombres de WhatsApp.
 *
 * - `servicio`: respuesta dentro de la ventana de 24 h que abrió la persona.
 *   Es el caso normal del agente y el más barato. Meta regala los primeros
 *   1 000 de cada número al mes (ver `SERVICIO_GRATIS_AL_MES`).
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

export type Precios = Record<Categoria, number>;

/**
 * LA TARIFA DE META, en microdólares por mensaje entregado.
 *
 * Fuente: tarjeta de tarifas de WhatsApp Business vigente desde el
 * 1 de octubre de 2026 (developers.facebook.com/docs/whatsapp/pricing).
 * Contrastada contra tres publicaciones independientes que citan la misma
 * tarjeta; coinciden en todos los mercados de abajo.
 *
 * Esto es lo que PAGAMOS, no lo que cobramos. Está acá para que el margen
 * sea un número explícito y no una cuenta de servilleta: cuando Meta cambie
 * la tarjeta, se corrigen estos valores y el precio de venta se recalcula
 * solo. Las filas ya cobradas no se tocan — llevan su precio congelado.
 *
 * Meta publica 47 mercados. Están los que importan acá; el resto cae en su
 * región «resto de».
 */
const COSTO_WHATSAPP: Record<Mercado, Precios> = {
  // Honduras y toda Centroamérica viven acá: no tienen tarifa propia.
  latam: { servicio: 11_300, utilidad: 11_300, autenticacion: 11_300, marketing: 74_000 },
  mexico: { servicio: 8_500, utilidad: 8_500, autenticacion: 8_500, marketing: 39_700 },
  colombia: { servicio: 800, utilidad: 800, autenticacion: 800, marketing: 12_500 },
  brasil: { servicio: 6_800, utilidad: 6_800, autenticacion: 6_800, marketing: 62_500 },
  argentina: { servicio: 26_000, utilidad: 26_000, autenticacion: 26_000, marketing: 61_800 },
  chile: { servicio: 20_000, utilidad: 20_000, autenticacion: 20_000, marketing: 88_900 },
  peru: { servicio: 30_000, utilidad: 30_000, autenticacion: 30_000, marketing: 70_300 },
  norteamerica: { servicio: 3_400, utilidad: 3_400, autenticacion: 3_400, marketing: 25_000 },
  espana: { servicio: 20_000, utilidad: 20_000, autenticacion: 20_000, marketing: 70_700 },
  'europa-occidental': { servicio: 17_100, utilidad: 17_100, autenticacion: 17_100, marketing: 59_200 },
  'europa-central': { servicio: 21_200, utilidad: 21_200, autenticacion: 21_200, marketing: 86_000 },
  africa: { servicio: 4_000, utilidad: 4_000, autenticacion: 4_000, marketing: 22_500 },
  'asia-pacifico': { servicio: 11_300, utilidad: 11_300, autenticacion: 11_300, marketing: 84_200 },
  'medio-oriente': { servicio: 9_100, utilidad: 9_100, autenticacion: 9_100, marketing: 39_200 },
  india: { servicio: 1_400, utilidad: 1_400, autenticacion: 1_400, marketing: 11_800 },
  indonesia: { servicio: 25_000, utilidad: 25_000, autenticacion: 25_000, marketing: 41_100 },
};

/**
 * Lo que nos cuesta cada canal, por mercado.
 *
 * WhatsApp tiene la tarjeta de Meta cargada. SMS y voz todavía no: sus
 * costos los pone Movitext según el operador, y van a entrar por la
 * pantalla de tarifas de la plataforma en vez de quedar escritos acá.
 * Mientras no haya tarifa cargada, un mensaje por esos canales NO se cobra
 * en cero — ver `precioDe`.
 */
const COSTO: Record<CanalCobrable, Partial<Record<Mercado, Precios>>> = {
  whatsapp: COSTO_WHATSAPP,
  sms: {},
  voz: {},
};

/**
 * Meta no cobra las primeras 1 000 respuestas de cada número por mes.
 *
 * Es el dato que más cambia el margen real: para un cliente chico, TODAS
 * sus respuestas son gratis para nosotros y se las cobramos igual. Está acá
 * nombrado y no escondido en una cuenta porque es la diferencia entre
 * entender el negocio y adivinarlo.
 */
export const SERVICIO_GRATIS_AL_MES = 1_000;

/**
 * Cuánto se cobra por encima de lo que cuesta.
 *
 * Es UNA decisión de negocio y vive en UN número. Al 2,0 el cliente paga el
 * doble de lo que nos cuesta el mensaje, que es lo que sostiene el soporte,
 * la plataforma y el margen. Subirlo o bajarlo es cambiar esta constante o,
 * por cliente, negociar la tarifa (ver `TarifaOrg`).
 *
 * OJO: este número hay que confirmarlo comercialmente. No sale de ninguna
 * fuente — la tarifa de Meta sí; el margen es de ustedes.
 */
export const MARGEN_POR_DEFECTO = 2.0;

/**
 * El techo de la tabla, por categoría.
 *
 * Es lo que se le cobra a un número que no se pudo ubicar. Se CALCULA del
 * máximo de cada columna en vez de escribirse a mano: así, cuando Meta suba
 * una tarifa, el caso desconocido sube con ella y nunca queda por debajo de
 * un mercado real. Un número raro cobrado barato es un mensaje subsidiado
 * que nadie nota.
 */
const MAS_CARO: Precios = CATEGORIAS.reduce((acc, c) => {
  acc[c] = Math.max(...Object.values(COSTO_WHATSAPP).map((p) => p[c]));
  return acc;
}, {} as Precios);

/**
 * Una lista de precios: la nuestra, o la de un cliente puntual.
 *
 * Las claves van de lo específico a lo general —país, después mercado— y
 * cada nivel puede traer solo algunas categorías. Un cliente que manda
 * medio millón de mensajes a Honduras consigue precio por Honduras, y eso
 * no puede obligar a tocar la tarifa de todos los demás.
 *
 * Lo que está acá es PRECIO DE VENTA, no costo: se usa tal cual, sin
 * aplicarle margen. Si no, negociar un precio daría otro distinto al
 * acordado — y el cliente tendría el correo donde se acordó el primero.
 */
export interface ListaPrecios {
  /** Por país: `{ HN: { servicio: 18000 } }`. */
  paises?: Record<string, Partial<Precios>>;
  /** Por mercado: `{ latam: { marketing: 120000 } }`. */
  mercados?: Partial<Record<Mercado, Partial<Precios>>>;
  /** Margen propio sobre el costo, cuando no hay precio fijado. */
  margen?: number;
}

/**
 * La tarifa de un canal. Lo de hoy es WhatsApp; SMS y voz entran igual sin
 * tocar código, poniendo su lista desde la pantalla de la plataforma.
 */
export type TarifaPorCanal = Partial<Record<CanalCobrable, ListaPrecios>>;

/**
 * Lo que decide un precio, de lo más fuerte a lo más débil.
 *
 * `cliente` le gana a `plataforma`, y `plataforma` le gana al costo por
 * margen. Esa cadena es el modelo de negocio entero: nosotros ponemos la
 * lista general, y un cliente grande negocia la suya sin que eso mueva la
 * de nadie más.
 */
export interface ContextoTarifa {
  canal?: string;
  /** Lo negociado con ESTE cliente. */
  cliente?: TarifaPorCanal;
  /** Nuestra lista de precios general, editable desde la plataforma. */
  plataforma?: TarifaPorCanal;
}

/** Busca un precio en una lista, de lo específico a lo general. */
function enLista(
  lista: ListaPrecios | undefined,
  iso: string,
  mercado: Mercado | null,
  categoria: Categoria,
): number | undefined {
  return (
    lista?.paises?.[iso]?.[categoria] ?? (mercado ? lista?.mercados?.[mercado]?.[categoria] : undefined)
  );
}

/**
 * Lo que NOS cuesta un mensaje. No se le muestra al cliente.
 *
 * Sin tarifa cargada para ese canal —hoy, SMS y voz— devuelve el techo de
 * la tabla en vez de cero. Un canal nuevo sin precio tiene que doler en el
 * margen, no regalarse: así se nota antes de facturar y no después.
 */
export function costoDe(iso: string, categoria: Categoria, canal: string = 'whatsapp'): number {
  const mercado = mercadoDe(iso);
  const delCanal = COSTO[canalValido(canal)];
  const precios = mercado ? delCanal[mercado] : undefined;
  return precios?.[categoria] ?? MAS_CARO[categoria];
}

/**
 * El precio de VENTA de un mensaje.
 *
 * Nunca devuelve cero por no encontrar nada: un cero silencioso es un
 * mensaje gratis que no se nota hasta fin de mes.
 */
export function precioDe(iso: string, categoria: Categoria, ctx: ContextoTarifa = {}): number {
  const canal = canalValido(ctx.canal);
  const mercado = mercadoDe(iso);

  const delCliente = enLista(ctx.cliente?.[canal], iso, mercado, categoria);
  if (delCliente !== undefined) return delCliente;

  const deLaPlataforma = enLista(ctx.plataforma?.[canal], iso, mercado, categoria);
  if (deLaPlataforma !== undefined) return deLaPlataforma;

  const margen =
    ctx.cliente?.[canal]?.margen ??
    ctx.plataforma?.[canal]?.margen ??
    MARGEN_POR_DEFECTO;
  const aplicado = margen > 0 ? margen : MARGEN_POR_DEFECTO;
  return Math.round(costoDe(iso, categoria, canal) * aplicado);
}

/** El costo de un mercado por canal, para la pantalla de la plataforma. */
export function costoMercado(mercado: Mercado, canal: string = 'whatsapp'): Precios | undefined {
  return COSTO[canalValido(canal)][mercado];
}

export function costosMeta(): Record<Mercado, Precios> {
  return COSTO_WHATSAPP;
}

/** Microdólares → «US$ 1.23». Lo que se imprime en la factura. */
export function enDolares(micros: number): string {
  return `US$ ${(micros / 1_000_000).toFixed(2)}`;
}
