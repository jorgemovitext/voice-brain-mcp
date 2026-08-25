import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { AuthGuard, SESSION_COOKIE } from './auth.guard';

/**
 * La sesión moría a las 12 h contadas desde el login, estuvieras trabajando o
 * no. Acá se fija lo contrario: al que está usando la consola no la echa, y
 * la del que se fue sigue caducando.
 */
describe('AuthGuard (sesión deslizante)', () => {
  const HORAS = 12;
  const SECRETO = 'secreto-de-prueba';
  const jwt = new JwtService({ secret: SECRETO, signOptions: { expiresIn: `${HORAS}h` } });
  const config = { get: (k: string, def?: unknown) => (k === 'AUTH_SESSION_HOURS' ? HORAS : def) };

  function build(expEnMs: number) {
    const cookies: Array<{ name: string; value: string }> = [];
    const req = {
      cookies: { [SESSION_COOKIE]: '' },
      headers: {},
    } as unknown as { cookies: Record<string, string>; headers: Record<string, string> };
    const res = {
      setCookie: (name: string, value: string) => cookies.push({ name, value }),
    };
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    const exp = Math.floor((Date.now() + expEnMs) / 1000);
    // Sin `expiresIn`: el `exp` va en el payload, que es lo que se quiere fijar.
    req.cookies[SESSION_COOKIE] = new JwtService({ secret: SECRETO }).sign({
      sub: 'u1',
      username: 'jorge.murcia',
      exp,
    });

    const guard = new AuthGuard(
      { getAllAndOverride: () => false } as unknown as Reflector,
      jwt,
      config as unknown as ConfigService,
    );
    return { guard, context, cookies };
  }

  it('renueva la cookie cuando la sesión pasó de la mitad de su vida', async () => {
    const { guard, context, cookies } = build(2 * 3600_000); // quedan 2 h de 12

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe(SESSION_COOKIE);
  });

  it('no la toca mientras esté fresca', async () => {
    const { guard, context, cookies } = build(11 * 3600_000); // quedan 11 h de 12

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(cookies).toHaveLength(0);
  });

  it('una sesión ya vencida no se renueva: hay que volver a entrar', async () => {
    const { guard, context, cookies } = build(-60_000);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cookies).toHaveLength(0);
  });
});
