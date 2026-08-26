import { PearlSyncController } from './pearl-sync.controller';

/**
 * Cuándo una conversación quedó inconclusa.
 *
 * La regla sale de NUESTROS avances y no del estado que reporta NL Pearl: sus
 * listados devuelven cero para esta cuenta, así que el estado de una
 * conversación concreta no se puede consultar.
 */
describe('Conversación inconclusa', () => {
  // Privada a propósito: nadie más debería decidir esto por su cuenta.
  const inconclusa = (pasos: string[], hace: number) =>
    (PearlSyncController as unknown as {
      quedoInconclusa(c: { pasos: Set<string>; ultimo: string }): boolean;
    }).quedoInconclusa({
      pasos: new Set(pasos),
      ultimo: new Date(Date.now() - hace).toISOString(),
    });

  const MINUTO = 60_000;

  it('el ciudadano dejó de responder y el caso nunca se registró', () => {
    expect(inconclusa(['opening', 'collectproblem'], 40 * MINUTO)).toBe(true);
  });

  it('una conversación que sigue viva no se marca', () => {
    // Se movió hace dos minutos: está escribiendo.
    expect(inconclusa(['opening', 'collectproblem'], 2 * MINUTO)).toBe(false);
  });

  it('si el reporte quedó registrado, concluyó', () => {
    expect(inconclusa(['opening', 'collectproblem', 'registered'], 40 * MINUTO)).toBe(false);
  });

  it('la despedida también cierra', () => {
    expect(inconclusa(['opening', 'farewell'], 40 * MINUTO)).toBe(false);
  });

  it('escalar al despacho es un desenlace, no un abandono', () => {
    expect(inconclusa(['opening', 'emergency', 'escalamiento'], 40 * MINUTO)).toBe(false);
  });

  it('el corte son 15 minutos: justo antes todavía no se marca', () => {
    expect(inconclusa(['opening'], 14 * MINUTO)).toBe(false);
    expect(inconclusa(['opening'], 16 * MINUTO)).toBe(true);
  });
});
