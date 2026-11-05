import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { matriz, permisosDe, puede, rolValido } from './permisos';
import { PermisosGuard, PERMISO_KEY } from './permisos.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

/*
 * Los permisos. Lo que se prueba acá no es la matriz —eso es una lista— sino
 * el DEFAULT del guard: qué pasa cuando alguien agrega un endpoint y se
 * olvida del decorador. Si el olvido abre la puerta, la matriz no sirve de
 * nada; tiene que cerrar.
 */

/** Un contexto HTTP de mentira, con lo que el guard mira. */
function contextoDe(opciones: { metodo?: string; rol?: string }): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ method: opciones.metodo ?? 'GET', user: { rol: opciones.rol } }),
    }),
  } as unknown as ExecutionContext;
}

/** Un Reflector que devuelve lo que se le indique por clave. */
function reflectorCon(metadatos: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (clave: string) => metadatos[clave],
  } as unknown as Reflector;
}

describe('La matriz de permisos', () => {
  it('el administrador puede todo lo que existe', () => {
    const todos = matriz().map((m) => m.permiso);
    expect(permisosDe('admin')).toEqual(expect.arrayContaining(todos));
  });

  it('el usuario atiende, pero no ve la factura ni cambia el plan', () => {
    /*
     * No es desconfianza: el consumo y el plan son del dueño del negocio.
     * Mostrarle a quien atiende el chat cuánto cuesta cada mensaje que
     * manda lo haría dudar antes de contestar.
     */
    expect(puede('usuario', 'conversar')).toBe(true);
    expect(puede('usuario', 'ver')).toBe(true);
    expect(puede('usuario', 'facturacion:ver')).toBe(false);
    expect(puede('usuario', 'facturacion:editar')).toBe(false);
    expect(puede('usuario', 'equipo:editar')).toBe(false);
  });

  it('cualquiera puede cerrar su propia sesión', () => {
    // Suena obvio y es justo lo que el default del guard rompería: cerrar
    // sesión es un POST, y sin este permiso un usuario quedaría encerrado.
    expect(puede('usuario', 'cuenta-propia')).toBe(true);
  });

  it('un rol que no reconocemos NO es administrador', () => {
    // Una fila vieja, un token de otra versión o un valor escrito a mano no
    // pueden ascender a nadie.
    expect(rolValido('supervisor')).toBe('usuario');
    expect(rolValido('root')).toBe('usuario');
    expect(rolValido(undefined)).toBe('usuario');
    expect(puede('supervisor', 'facturacion:editar')).toBe(false);
  });
});

describe('El guard de permisos', () => {
  it('con el permiso declarado, deja pasar a quien lo tiene', () => {
    const guard = new PermisosGuard(reflectorCon({ [PERMISO_KEY]: 'conversar' }));
    expect(guard.canActivate(contextoDe({ metodo: 'POST', rol: 'usuario' }))).toBe(true);
  });

  it('con el permiso declarado, frena a quien no lo tiene', () => {
    const guard = new PermisosGuard(reflectorCon({ [PERMISO_KEY]: 'facturacion:ver' }));
    expect(() => guard.canActivate(contextoDe({ metodo: 'GET', rol: 'usuario' }))).toThrow(ForbiddenException);
  });

  it('SIN decorador, un POST solo lo hace el administrador', () => {
    /*
     * Esta es la propiedad que sostiene todo. Alguien agrega un endpoint que
     * modifica algo y se olvida del decorador: queda cerrado de más —solo el
     * administrador— y no abierto a cualquiera. Los olvidos ocurren; lo que
     * se elige es de qué lado fallan.
     */
    const guard = new PermisosGuard(reflectorCon({}));

    for (const metodo of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => guard.canActivate(contextoDe({ metodo, rol: 'usuario' }))).toThrow(ForbiddenException);
      expect(guard.canActivate(contextoDe({ metodo, rol: 'admin' }))).toBe(true);
    }
  });

  it('SIN decorador, una lectura la hace cualquiera con sesión', () => {
    // Un usuario atiende conversaciones: cerrarle las lecturas por omisión
    // sería dejarlo sin la pantalla donde trabaja.
    const guard = new PermisosGuard(reflectorCon({}));
    expect(guard.canActivate(contextoDe({ metodo: 'GET', rol: 'usuario' }))).toBe(true);
  });

  it('lo público no pasa por acá: un webhook no es nadie del equipo', () => {
    const guard = new PermisosGuard(reflectorCon({ [IS_PUBLIC_KEY]: true }));
    expect(guard.canActivate(contextoDe({ metodo: 'POST' }))).toBe(true);
  });

  it('sin rol en el token, un POST no pasa', () => {
    // Un token viejo firmado antes de que existieran los roles no habilita
    // a configurar la cuenta.
    const guard = new PermisosGuard(reflectorCon({}));
    expect(() => guard.canActivate(contextoDe({ metodo: 'POST' }))).toThrow(ForbiddenException);
  });
});
