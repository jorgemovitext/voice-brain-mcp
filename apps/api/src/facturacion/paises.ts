/**
 * De qué país es un número, y en qué grupo de precio cae.
 *
 * Existe porque un mensaje no cuesta lo mismo a Honduras que a España: el
 * precio de WhatsApp lo fija el país de DESTINO, y si cobráramos un precio
 * único estaríamos regalando los mensajes caros y encareciendo los baratos.
 * O sea: perdiendo plata en los clientes que más mandan y espantando a los
 * que mandan poco.
 *
 * El país sale del prefijo del número en E.164 y se resuelve por prefijo MÁS
 * LARGO, no por el primero que calce: +1 es Estados Unidos, pero +1809 es
 * República Dominicana y cuesta distinto. Con un emparejado corto, todo el
 * Caribe se facturaría como Norteamérica.
 */

/** Los grupos de precio. Cobrar por país uno por uno son 200 filas que nadie mantiene. */
export type GrupoPais =
  | 'centroamerica'
  | 'mexico'
  | 'norteamerica'
  | 'sudamerica'
  | 'caribe'
  | 'europa'
  | 'resto';

export interface Pais {
  /** ISO 3166-1 alfa-2. `ZZ` cuando el número no se pudo ubicar. */
  iso: string;
  nombre: string;
  grupo: GrupoPais;
}

/**
 * Prefijo telefónico → país. No es la lista completa del mundo: son los
 * países donde hay clientes o adonde se les escribe, y el resto cae en
 * `resto` con su precio. Agregar un país es una línea.
 */
const POR_PREFIJO: Array<[string, Pais]> = [
  // Centroamérica — el mercado de Hive.
  ['504', { iso: 'HN', nombre: 'Honduras', grupo: 'centroamerica' }],
  ['502', { iso: 'GT', nombre: 'Guatemala', grupo: 'centroamerica' }],
  ['503', { iso: 'SV', nombre: 'El Salvador', grupo: 'centroamerica' }],
  ['505', { iso: 'NI', nombre: 'Nicaragua', grupo: 'centroamerica' }],
  ['506', { iso: 'CR', nombre: 'Costa Rica', grupo: 'centroamerica' }],
  ['507', { iso: 'PA', nombre: 'Panamá', grupo: 'centroamerica' }],
  ['501', { iso: 'BZ', nombre: 'Belice', grupo: 'centroamerica' }],

  ['52', { iso: 'MX', nombre: 'México', grupo: 'mexico' }],

  // Norteamérica y el Caribe comparten el +1: el prefijo largo manda.
  ['1787', { iso: 'PR', nombre: 'Puerto Rico', grupo: 'caribe' }],
  ['1939', { iso: 'PR', nombre: 'Puerto Rico', grupo: 'caribe' }],
  ['1809', { iso: 'DO', nombre: 'República Dominicana', grupo: 'caribe' }],
  ['1829', { iso: 'DO', nombre: 'República Dominicana', grupo: 'caribe' }],
  ['1849', { iso: 'DO', nombre: 'República Dominicana', grupo: 'caribe' }],
  ['1', { iso: 'US', nombre: 'Estados Unidos y Canadá', grupo: 'norteamerica' }],

  ['57', { iso: 'CO', nombre: 'Colombia', grupo: 'sudamerica' }],
  ['593', { iso: 'EC', nombre: 'Ecuador', grupo: 'sudamerica' }],
  ['51', { iso: 'PE', nombre: 'Perú', grupo: 'sudamerica' }],
  ['591', { iso: 'BO', nombre: 'Bolivia', grupo: 'sudamerica' }],
  ['58', { iso: 'VE', nombre: 'Venezuela', grupo: 'sudamerica' }],
  ['56', { iso: 'CL', nombre: 'Chile', grupo: 'sudamerica' }],
  ['54', { iso: 'AR', nombre: 'Argentina', grupo: 'sudamerica' }],
  ['598', { iso: 'UY', nombre: 'Uruguay', grupo: 'sudamerica' }],
  ['595', { iso: 'PY', nombre: 'Paraguay', grupo: 'sudamerica' }],
  ['55', { iso: 'BR', nombre: 'Brasil', grupo: 'sudamerica' }],

  ['53', { iso: 'CU', nombre: 'Cuba', grupo: 'caribe' }],
  ['509', { iso: 'HT', nombre: 'Haití', grupo: 'caribe' }],

  ['34', { iso: 'ES', nombre: 'España', grupo: 'europa' }],
  ['39', { iso: 'IT', nombre: 'Italia', grupo: 'europa' }],
  ['49', { iso: 'DE', nombre: 'Alemania', grupo: 'europa' }],
  ['33', { iso: 'FR', nombre: 'Francia', grupo: 'europa' }],
  ['44', { iso: 'GB', nombre: 'Reino Unido', grupo: 'europa' }],
  ['351', { iso: 'PT', nombre: 'Portugal', grupo: 'europa' }],
];

/** Del más largo al más corto: así +1809 gana sobre +1. */
const ORDENADOS = [...POR_PREFIJO].sort((a, b) => b[0].length - a[0].length);

/**
 * El país desconocido.
 *
 * Un número que no se pudo ubicar NO se factura gratis: se cobra la tarifa
 * del grupo más caro. Al revés —gratis por defecto— cualquier número raro
 * sería un mensaje regalado, y el error se descubriría al cerrar el mes.
 */
export const PAIS_DESCONOCIDO: Pais = { iso: 'ZZ', nombre: 'Sin identificar', grupo: 'resto' };

export function paisDe(telefono?: string): Pais {
  const digitos = (telefono ?? '').replace(/\D/g, '');
  if (!digitos) return PAIS_DESCONOCIDO;
  for (const [prefijo, pais] of ORDENADOS) {
    if (digitos.startsWith(prefijo)) return pais;
  }
  return PAIS_DESCONOCIDO;
}

/** Para mostrar: «Honduras» en vez de «HN» en la pantalla de uso. */
export function nombrePais(iso: string): string {
  if (iso === PAIS_DESCONOCIDO.iso) return PAIS_DESCONOCIDO.nombre;
  return POR_PREFIJO.find(([, p]) => p.iso === iso)?.[1].nombre ?? iso;
}

export function grupoDe(iso: string): GrupoPais {
  if (iso === PAIS_DESCONOCIDO.iso) return PAIS_DESCONOCIDO.grupo;
  return POR_PREFIJO.find(([, p]) => p.iso === iso)?.[1].grupo ?? 'resto';
}

/** Los países conocidos, para el catálogo de tarifas de la consola. */
export function paises(): Pais[] {
  const vistos = new Map<string, Pais>();
  for (const [, p] of POR_PREFIJO) if (!vistos.has(p.iso)) vistos.set(p.iso, p);
  return [...vistos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
