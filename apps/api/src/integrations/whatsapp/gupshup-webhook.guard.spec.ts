import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GupshupWebhookGuard } from './gupshup-webhook.guard';

/**
 * El guard opt-in del webhook de Gupshup.
 *
 * Lo crítico de fijar: SIN token configurado deja pasar (idéntico a hoy, no
 * rompe los entrantes que ya funcionan), y CON token exige el valor correcto
 * por header o query.
 */

function guard(token: string): GupshupWebhookGuard {
  const config = { get: (k: string, def?: unknown) => (k === 'GUPSHUP_WEBHOOK_TOKEN' ? token : def) };
  return new GupshupWebhookGuard(config as unknown as ConfigService);
}

function ctx(opts: { header?: string; query?: string }): ExecutionContext {
  const req = {
    headers: opts.header ? { 'x-webhook-token': opts.header } : {},
    query: opts.query ? { token: opts.query } : {},
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('GupshupWebhookGuard', () => {
  it('sin token configurado deja pasar cualquier cosa (passthrough, no rompe lo actual)', () => {
    expect(guard('').canActivate(ctx({}))).toBe(true);
  });

  it('con token, acepta el valor correcto por header', () => {
    expect(guard('s3cr3to').canActivate(ctx({ header: 's3cr3to' }))).toBe(true);
  });

  it('con token, acepta el valor correcto por ?token=', () => {
    expect(guard('s3cr3to').canActivate(ctx({ query: 's3cr3to' }))).toBe(true);
  });

  it('con token, rechaza el valor incorrecto', () => {
    expect(() => guard('s3cr3to').canActivate(ctx({ header: 'otro' }))).toThrow(UnauthorizedException);
  });

  it('con token, rechaza cuando no viene ninguno', () => {
    expect(() => guard('s3cr3to').canActivate(ctx({}))).toThrow(UnauthorizedException);
  });
});
