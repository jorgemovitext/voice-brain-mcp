/**
 * De qué país es un número, y en qué MERCADO de Meta cae.
 *
 * Existe porque un mensaje no cuesta lo mismo a Honduras que a España: el
 * precio lo fija el país de DESTINO, y si cobráramos un precio único
 * estaríamos regalando los mensajes caros y encareciendo los baratos. O sea:
 * perdiendo plata en los clientes que más mandan y espantando a los que
 * mandan poco.
 *
 * Los grupos NO son nuestros: son los mercados con los que Meta factura.
 * Son 47 —39 países con tarifa propia y 8 regiones «resto de»— y copiar esa
 * estructura en vez de inventar la nuestra es lo que hace que el costo y el
 * cobro se puedan comparar línea por línea. Con grupos propios, cuadrar
 * nuestra factura contra la de Meta sería un trabajo manual cada mes.
 *
 * Honduras y el resto de Centroamérica NO tienen tarifa propia: caen en
 * «Resto de Latinoamérica». Eso sorprende y es así.
 *
 * El país sale del prefijo en E.164 y se resuelve por prefijo MÁS LARGO, no
 * por el primero que calce: +1 es Estados Unidos, pero +1809 es República
 * Dominicana y es otro mercado. Con un emparejado corto, el Caribe entero se
 * facturaría como Norteamérica — el mercado más barato de la tabla.
 */

/**
 * Los mercados de Meta que nos tocan. No están los 47: están aquellos adonde
 * hay o puede haber clientes, y el resto cae en una región «resto de».
 */
export type Mercado =
  | 'latam'
  | 'mexico'
  | 'colombia'
  | 'brasil'
  | 'argentina'
  | 'chile'
  | 'peru'
  | 'norteamerica'
  | 'espana'
  | 'europa-occidental'
  | 'europa-central'
  | 'africa'
  | 'asia-pacifico'
  | 'medio-oriente'
  | 'india'
  | 'indonesia';

export const NOMBRE_MERCADO: Record<Mercado, string> = {
  latam: 'Resto de Latinoamérica',
  mexico: 'México',
  colombia: 'Colombia',
  brasil: 'Brasil',
  argentina: 'Argentina',
  chile: 'Chile',
  peru: 'Perú',
  norteamerica: 'Norteamérica',
  espana: 'España',
  'europa-occidental': 'Resto de Europa Occidental',
  'europa-central': 'Resto de Europa Central y del Este',
  africa: 'Resto de África',
  'asia-pacifico': 'Resto de Asia-Pacífico',
  'medio-oriente': 'Resto de Medio Oriente',
  india: 'India',
  indonesia: 'Indonesia',
};

export interface Pais {
  /** ISO 3166-1 alfa-2. `ZZ` cuando el número no se pudo ubicar. */
  iso: string;
  nombre: string;
  mercado: Mercado;
  /**
   * El prefijo que decidió el país, cuando se resolvió desde un número.
   *
   * Se devuelve y se guarda en el registro de facturación porque es lo que
   * permite EXPLICAR un cobro: por qué un +1809 se facturó como Dominicana
   * y no como Estados Unidos. Sin esto, un reclamo se contesta con «confiá
   * en el código».
   */
  prefijo?: string;
}

/**
 * Prefijo telefónico → país. No es la lista completa del mundo: son los
 * países donde hay clientes o adonde se les escribe. Agregar uno es una
 * línea, y lo que no está cae en el mercado más caro.
 */
const POR_PREFIJO: Array<[string, Pais]> = [
  // Centroamérica — el mercado de Hive. Ninguno tiene tarifa propia en Meta.
  ['504', { iso: 'HN', nombre: 'Honduras', mercado: 'latam' }],
  ['502', { iso: 'GT', nombre: 'Guatemala', mercado: 'latam' }],
  ['503', { iso: 'SV', nombre: 'El Salvador', mercado: 'latam' }],
  ['505', { iso: 'NI', nombre: 'Nicaragua', mercado: 'latam' }],
  ['506', { iso: 'CR', nombre: 'Costa Rica', mercado: 'latam' }],
  ['507', { iso: 'PA', nombre: 'Panamá', mercado: 'latam' }],
  ['501', { iso: 'BZ', nombre: 'Belice', mercado: 'latam' }],

  // Los latinoamericanos que SÍ tienen tarifa propia.
  ['52', { iso: 'MX', nombre: 'México', mercado: 'mexico' }],
  ['57', { iso: 'CO', nombre: 'Colombia', mercado: 'colombia' }],
  ['55', { iso: 'BR', nombre: 'Brasil', mercado: 'brasil' }],
  ['54', { iso: 'AR', nombre: 'Argentina', mercado: 'argentina' }],
  ['56', { iso: 'CL', nombre: 'Chile', mercado: 'chile' }],
  ['51', { iso: 'PE', nombre: 'Perú', mercado: 'peru' }],

  // El resto de Sudamérica, sin tarifa propia.
  ['593', { iso: 'EC', nombre: 'Ecuador', mercado: 'latam' }],
  ['591', { iso: 'BO', nombre: 'Bolivia', mercado: 'latam' }],
  ['58', { iso: 'VE', nombre: 'Venezuela', mercado: 'latam' }],
  ['598', { iso: 'UY', nombre: 'Uruguay', mercado: 'latam' }],
  ['595', { iso: 'PY', nombre: 'Paraguay', mercado: 'latam' }],

  /*
   * El +1 lo comparten Norteamérica y el Caribe, y son mercados distintos.
   * Meta cobra por el código de marcación del destinatario, así que el
   * prefijo largo es el que decide: estas filas tienen que ganarle a ['1'].
   *
   * Puerto Rico queda en Norteamérica: es territorio de Estados Unidos y sus
   * números son de operadores de allá. No lo tengo confirmado contra la
   * tarjeta de Meta — si aparece como Latinoamérica, se corrige acá y las
   * filas ya cobradas no se tocan, porque llevan su precio congelado.
   */
  ['1787', { iso: 'PR', nombre: 'Puerto Rico', mercado: 'norteamerica' }],
  ['1939', { iso: 'PR', nombre: 'Puerto Rico', mercado: 'norteamerica' }],
  ['1809', { iso: 'DO', nombre: 'República Dominicana', mercado: 'latam' }],
  ['1829', { iso: 'DO', nombre: 'República Dominicana', mercado: 'latam' }],
  ['1849', { iso: 'DO', nombre: 'República Dominicana', mercado: 'latam' }],
  ['1', { iso: 'US', nombre: 'Estados Unidos y Canadá', mercado: 'norteamerica' }],

  ['53', { iso: 'CU', nombre: 'Cuba', mercado: 'latam' }],
  ['509', { iso: 'HT', nombre: 'Haití', mercado: 'latam' }],

  ['34', { iso: 'ES', nombre: 'España', mercado: 'espana' }],
  ['39', { iso: 'IT', nombre: 'Italia', mercado: 'europa-occidental' }],
  ['49', { iso: 'DE', nombre: 'Alemania', mercado: 'europa-occidental' }],
  ['33', { iso: 'FR', nombre: 'Francia', mercado: 'europa-occidental' }],
  ['44', { iso: 'GB', nombre: 'Reino Unido', mercado: 'europa-occidental' }],
  ['351', { iso: 'PT', nombre: 'Portugal', mercado: 'europa-occidental' }],

  ['91', { iso: 'IN', nombre: 'India', mercado: 'india' }],
  ['62', { iso: 'ID', nombre: 'Indonesia', mercado: 'indonesia' }],
];

/** Del más largo al más corto: así +1809 gana sobre +1. */
const ORDENADOS = [...POR_PREFIJO].sort((a, b) => b[0].length - a[0].length);

/**
 * El país desconocido.
 *
 * Un número que no se pudo ubicar NO se factura gratis ni barato: se le
 * aplica el precio más alto de toda la tabla (ver `tarifas.ts`). Al revés
 * —gratis o al precio de Honduras— cualquier número raro sería un mensaje
 * subsidiado, y el error se descubriría al cerrar el mes.
 */
export const PAIS_DESCONOCIDO: Pais = { iso: 'ZZ', nombre: 'Sin identificar', mercado: 'latam' };

export function paisDe(telefono?: string): Pais {
  const digitos = (telefono ?? '').replace(/\D/g, '');
  if (!digitos) return PAIS_DESCONOCIDO;
  for (const [prefijo, pais] of ORDENADOS) {
    if (digitos.startsWith(prefijo)) return { ...pais, prefijo };
  }
  return PAIS_DESCONOCIDO;
}

/** Para mostrar: «Honduras» en vez de «HN» en la pantalla de uso. */
export function nombrePais(iso: string): string {
  if (iso === PAIS_DESCONOCIDO.iso) return PAIS_DESCONOCIDO.nombre;
  return POR_PREFIJO.find(([, p]) => p.iso === iso)?.[1].nombre ?? iso;
}

/** En qué mercado de Meta factura este país. */
export function mercadoDe(iso: string): Mercado | null {
  if (iso === PAIS_DESCONOCIDO.iso) return null;
  return POR_PREFIJO.find(([, p]) => p.iso === iso)?.[1].mercado ?? null;
}

/** Los países conocidos, para el catálogo de tarifas de la consola. */
export function paises(): Pais[] {
  const vistos = new Map<string, Pais>();
  for (const [, p] of POR_PREFIJO) if (!vistos.has(p.iso)) vistos.set(p.iso, p);
  return [...vistos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
