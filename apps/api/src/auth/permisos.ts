/**
 * Quién puede hacer qué: dos roles y una matriz.
 *
 * Antes había tres —administrador, supervisor y operador— y dos de ellos se
 * diferenciaban en el tipo y en NINGÚN permiso: eran el mismo rol con dos
 * nombres, y lo único que lograban era que alguien eligiera mal al invitar.
 * Quedan dos, que es la división que el negocio tiene de verdad:
 *
 *  - `admin`: configura y paga. Agentes, números, equipo, plan y tarifas.
 *  - `usuario`: atiende. Lee el tablero y conversa con la gente.
 *
 * La matriz vive en UN archivo a propósito. Repartida en `if (rol ===
 * 'admin')` por los controllers, la pregunta «¿qué puede hacer un usuario?»
 * solo se responde leyendo toda la API — y la respuesta cambia sin que nadie
 * lo note.
 */

export type Rol = 'admin' | 'usuario';

export const ROLES: Rol[] = ['admin', 'usuario'];

export const NOMBRE_ROL: Record<Rol, string> = {
  admin: 'Administrador',
  usuario: 'Usuario',
};

export const DESCRIPCION_ROL: Record<Rol, string> = {
  admin: 'Configura los agentes, los números, el equipo y el plan. Ve el consumo y la factura.',
  usuario: 'Atiende conversaciones y ve el tablero. No cambia la configuración ni el plan.',
};

/**
 * Los permisos, en el idioma del negocio y no en el de la API.
 *
 * Son pocos y gruesos a propósito: un permiso por endpoint se vuelve
 * imposible de explicarle a quien invita a un colega, y lo que no se puede
 * explicar se configura mal.
 */
export type Permiso =
  | 'ver'
  | 'conversar'
  | 'cuenta-propia'
  | 'agentes:editar'
  | 'canales:editar'
  | 'equipo:editar'
  | 'config:editar'
  | 'seguimiento:editar'
  | 'facturacion:ver'
  | 'facturacion:editar';

export const NOMBRE_PERMISO: Record<Permiso, string> = {
  ver: 'Ver el tablero y las conversaciones',
  conversar: 'Tomar conversaciones y escribirle a la gente',
  'cuenta-propia': 'Cerrar su sesión y cambiar sus propios datos',
  'agentes:editar': 'Crear y editar agentes',
  'canales:editar': 'Dar de alta números de WhatsApp',
  'equipo:editar': 'Invitar gente y cambiar roles',
  'config:editar': 'Cambiar la configuración de la cuenta',
  'seguimiento:editar': 'Configurar el seguimiento automático',
  'facturacion:ver': 'Ver el consumo y la factura',
  'facturacion:editar': 'Cambiar el plan, el tope de gasto y las tarifas',
};

const MATRIZ: Record<Rol, Permiso[]> = {
  admin: [
    'ver',
    'conversar',
    'cuenta-propia',
    'agentes:editar',
    'canales:editar',
    'equipo:editar',
    'config:editar',
    'seguimiento:editar',
    'facturacion:ver',
    'facturacion:editar',
  ],
  /*
   * El usuario no ve la factura. No es desconfianza: es que el consumo y el
   * plan son del dueño del negocio, y mostrarle a quien atiende el chat
   * cuánto cuesta cada mensaje que manda lo haría dudar antes de contestar.
   */
  usuario: ['ver', 'conversar', 'cuenta-propia'],
};

/** Un rol que no reconocemos se trata como el más limitado, nunca como admin. */
export function rolValido(rol?: string): Rol {
  return rol === 'admin' ? 'admin' : 'usuario';
}

export function puede(rol: string | undefined, permiso: Permiso): boolean {
  return MATRIZ[rolValido(rol)].includes(permiso);
}

export function permisosDe(rol?: string): Permiso[] {
  return [...MATRIZ[rolValido(rol)]];
}

/** La matriz completa, para mostrarla en la pantalla de equipo. */
export function matriz(): Array<{ permiso: Permiso; nombre: string; admin: boolean; usuario: boolean }> {
  return (Object.keys(NOMBRE_PERMISO) as Permiso[]).map((permiso) => ({
    permiso,
    nombre: NOMBRE_PERMISO[permiso],
    admin: MATRIZ.admin.includes(permiso),
    usuario: MATRIZ.usuario.includes(permiso),
  }));
}
