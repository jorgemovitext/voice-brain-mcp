import { ExecutionContext, HttpException } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * El freno por IP de los endpoints públicos de auth.
 *
 * Lo importante de fijar: cuenta por IP (no global), y que un fallo interno
 * deja pasar en vez de trabar el login — perder el freno un rato es preferible
 * a dejar a los operadores afuera.
 */

/** Contexto con la IP en x-forwarded-for, como llega detrás del proxy de Vercel. */
function ctx(ip: string, headerRoto = false): ExecutionContext {
  const req = headerRoto
    ? // Un getter que lanza: simula el fallo interno para probar el fail-open.
      new Proxy({}, { get: () => { throw new Error('request ilegible'); } })
    : { headers: { 'x-forwarded-for': ip }, ip };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('deja pasar hasta el tope y recién ahí corta', () => {
    const guard = new RateLimitGuard();
    // 20 es el tope: las primeras 20 pasan, la 21 corta.
    for (let i = 0; i < 20; i++) expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow(HttpException);
  });

  it('cuenta por IP: una IP saturada no afecta a otra', () => {
    const guard = new RateLimitGuard();
    for (let i = 0; i < 20; i++) guard.canActivate(ctx('1.1.1.1'));
    // La primera IP ya está al tope...
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow(HttpException);
    // ...pero otra entra sin problema.
    expect(guard.canActivate(ctx('2.2.2.2'))).toBe(true);
  });

  it('falla ABIERTO: si no puede leer la petición, deja pasar', () => {
    const guard = new RateLimitGuard();
    expect(guard.canActivate(ctx('', true))).toBe(true);
  });

  it('toma la primera IP de la lista de x-forwarded-for', () => {
    const guard = new RateLimitGuard();
    const conCadena = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }) }),
    } as unknown as ExecutionContext;
    // Satura 9.9.9.9 vía la cadena...
    for (let i = 0; i < 20; i++) guard.canActivate(conCadena);
    expect(() => guard.canActivate(conCadena)).toThrow(HttpException);
    // ...y confirma que fue esa IP la contada, no el proxy 10.0.0.1.
    expect(guard.canActivate(ctx('10.0.0.1'))).toBe(true);
  });
});
