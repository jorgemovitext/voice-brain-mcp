import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * De qué organización es la petición que se está atendiendo.
 *
 * Hive pasó a ser un SaaS de alta pública: cualquiera se registra y recibe
 * SU espacio. Eso solo es seguro si los datos están separados de verdad —
 * sin esto, registrarse sería ver los contactos y las conversaciones de los
 * ciudadanos de otro cliente, que es el agujero que ya se cerró una vez.
 *
 * Va en AsyncLocalStorage y no en providers con scope REQUEST a propósito:
 * el scope de petición en Nest es viral (todo lo que lo inyecta se vuelve
 * también de petición, incluidos servicios que hoy son únicos) y se paga en
 * cada resolución. Acá el contexto viaja con la ejecución async sin que
 * ningún servicio cambie de forma.
 *
 * La organización NUNCA llega por parámetro desde el cliente: sale del token
 * de sesión. Un filtro que el navegador puede elegir no es aislamiento.
 */

export interface ContextoPeticion {
  /** La organización dueña de los datos. */
  org: string;
  /** Quién la pidió, para la bitácora. */
  usuario?: string;
}

const almacen = new AsyncLocalStorage<ContextoPeticion>();

/** Corre `fn` con este contexto. Lo usa el interceptor en cada petición. */
export function conContexto<T>(ctx: ContextoPeticion, fn: () => T): T {
  return almacen.run(ctx, fn);
}

/**
 * La organización de la petición en curso.
 *
 * `undefined` fuera de una petición HTTP: el servidor MCP, los cron y los
 * scripts corren sin contexto. Cada consumidor decide qué hacer con eso —
 * la regla general es que un trabajo de fondo opera sobre la organización
 * que tenga anotada el recurso, no sobre «todas».
 */
export function orgActual(): string | undefined {
  return almacen.getStore()?.org;
}

export function usuarioActual(): string | undefined {
  return almacen.getStore()?.usuario;
}

/**
 * La organización de los datos que existían ANTES de que hubiera
 * organizaciones.
 *
 * Toda la historia de la Línea 100 se guardó sin marca. Si se dejara en
 * NULL, el primer filtro la escondería de todos y parecería que se perdió;
 * si se mostrara a cualquiera, sería la fuga que esto viene a evitar. Se le
 * pone dueño explícito en la migración y queda tratada como una
 * organización más.
 */
export const ORG_HISTORICA = 'org-movitext';
