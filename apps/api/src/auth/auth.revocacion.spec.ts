import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard, SESSION_COOKIE } from './auth.guard';

/*
 * Revocación de sesiones.
 *
 * Un JWT no se puede revocar: una vez firmado vale hasta que expira. Con
 * sesiones de 12 horas, a alguien a quien le quitaron la cuenta le quedaba
 * medio día de acceso con el token que ya tenía en el navegador — y eso se
 * volvió un agujero de verdad el día que se agregó la baja de cuentas.
 */

const SECRETO = 'secreto-de-prueba';

function armar(opciones: { usuario: unknown; emitidoHaceMs?: number }) {
  const jwt = new JwtService({ secret: SECRETO });
  const emitido = Math.floor((Date.now() - (opciones.emitidoHaceMs ?? 0)) / 1000);
  const token = jwt.sign({
    sub: 'u1',
    username: 'jorge',
    iat: emitido,
    exp: Math.floor((Date.now() + 6 * 3600_000) / 1000),
  });

  const req = { cookies: { [SESSION_COOKIE]: token }, headers: {} };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;

  const guard = new AuthGuard(
    { getAllAndOverride: () => false } as unknown as Reflector,
    jwt,
    { findById: async () => opciones.usuario } as never,
    { get: (_k: string, d?: unknown) => d } as unknown as ConfigService,
  );
  return { guard, context };
}

describe('AuthGuard · revocación', () => {
  it('una cuenta BORRADA no entra, aunque su token siga firmado y vigente', async () => {
    const { guard, context } = armar({ usuario: undefined });
    await expect(guard.canActivate(context)).rejects.toThrow(/Sesión cerrada/i);
  });

  it('un token anterior a la revocación no vale', async () => {
    // Token de hace una hora; las sesiones se cerraron hace un minuto.
    const { guard, context } = armar({
      usuario: { id: 'u1', tokensDesde: new Date(Date.now() - 60_000).toISOString() },
      emitidoHaceMs: 3600_000,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(/Sesión cerrada/i);
  });

  it('un token POSTERIOR a la revocación sí vale: el que volvió a entrar sigue adentro', async () => {
    const { guard, context } = armar({
      usuario: { id: 'u1', tokensDesde: new Date(Date.now() - 3600_000).toISOString() },
      emitidoHaceMs: 0,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('si la base falla, NO echa a nadie', async () => {
    /*
     * Una base caída no puede dejar a la consola entera afuera: el token ya
     * demostró estar firmado por nosotros y no haber expirado, que es el
     * piso que había antes de la revocación.
     */
    const jwt = new JwtService({ secret: SECRETO });
    const token = jwt.sign({ sub: 'u1', exp: Math.floor((Date.now() + 3600_000) / 1000) });
    const req = { cookies: { [SESSION_COOKIE]: token }, headers: {} };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;

    const guard = new AuthGuard(
      { getAllAndOverride: () => false } as unknown as Reflector,
      jwt,
      { findById: async () => { throw new Error('Neon caído'); } } as never,
      { get: (_k: string, d?: unknown) => d } as unknown as ConfigService,
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
