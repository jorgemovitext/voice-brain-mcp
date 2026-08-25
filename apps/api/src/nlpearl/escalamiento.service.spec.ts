import { ConfigService } from '@nestjs/config';
import { NlpearlActivityStore, StoredActivity } from './activity.store';
import { EscalamientoService } from './escalamiento.service';

/**
 * El umbral decide si se despierta al despacho del alcalde. El guardarraíl
 * del guion es "nunca inventar urgencia", así que lo que se prueba acá es
 * tanto que escale cuando debe como —sobre todo— que NO escale cuando no.
 */
describe('EscalamientoService', () => {
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  const reporte = (phone: string, ubicacion: string, min = 5): StoredActivity => ({
    id: `avance:${phone}:collectLocation`,
    phone,
    kind: 'progress',
    occurredAt: hace(min),
    raw: { conversationId: phone, paso: 'collectLocation', datos: { ubicacion } },
  });

  const servicio = (avances: StoredActivity[]) =>
    new EscalamientoService(
      { listActivity: async () => avances } as unknown as NlpearlActivityStore,
      new ConfigService({}),
    );

  const MIRADOR = 'Colonia Mirador del Pinar';

  it('no escala un caso aislado, aunque bloquee el paso hace poco', async () => {
    const r = await servicio([reporte('+50497000001', MIRADOR, 2)]).evaluar({
      ubicacion: MIRADOR,
      telefono: '+50497000001',
      obstruyePaso: 'sí',
    });

    expect(r.escalar).toBe(false);
    expect(r.nivel).toBe('normal');
    expect(r.mensaje).toBe('');
  });

  it('escala por volumen cuando muchos reportan el mismo incidente', async () => {
    const muchos = Array.from({ length: 12 }, (_, i) => reporte(`+5049700${1000 + i}`, MIRADOR));
    const r = await servicio(muchos).evaluar({ ubicacion: MIRADOR, folio: 'L100-DEMO-DER-0045' });

    expect(r.escalar).toBe(true);
    expect(r.nivel).toBe('E3_EXECUTIVE');
    expect(r.reportes).toBe(12);
    expect(r.mensaje).toContain('L100-DEMO-DER-0045');
    expect(r.mensaje).toContain('12 reportes');
  });

  it('escala por impacto: pocos reportes pero el paso lleva rato bloqueado', async () => {
    const r = await servicio([reporte('+50497000001', MIRADOR, 45)]).evaluar({
      ubicacion: MIRADOR,
      telefono: '+50497000001',
      obstruyePaso: 'sí',
    });

    expect(r.escalar).toBe(true);
    expect(r.motivo).toContain('bloqueado');
    expect(r.minutosSinResolver).toBeGreaterThanOrEqual(30);
  });

  it('agrupa el mismo lugar aunque cada vecino lo escriba distinto', async () => {
    const variantes = [
      reporte('+50497000001', 'col. Mirador del Pinar'),
      reporte('+50497000002', 'Colonia Mirador del Pinar, entrada'),
      reporte('+50497000003', 'MIRADOR DEL PINAR'),
    ];
    const r = await servicio(variantes).evaluar({ ubicacion: MIRADOR });

    expect(r.reportes).toBe(3);
  });

  it('no cuenta dos veces a quien empuja varios pasos del flujo', async () => {
    const mismaPersona: StoredActivity[] = ['collectProblem', 'collectLocation', 'collectDesc'].map(
      (paso) => ({
        id: `avance:c1:${paso}`,
        phone: '+50497000001',
        kind: 'progress',
        occurredAt: hace(3),
        raw: { conversationId: 'c1', paso, datos: { ubicacion: MIRADOR } },
      }),
    );
    const r = await servicio(mismaPersona).evaluar({ ubicacion: MIRADOR });

    // Tres avances, una sola persona afectada.
    expect(r.reportes).toBe(1);
    expect(r.escalar).toBe(false);
  });

  it('ignora reportes de otra ubicación', async () => {
    const otros = Array.from({ length: 12 }, (_, i) =>
      reporte(`+5049700${2000 + i}`, 'Colonia Kennedy'),
    );
    const r = await servicio(otros).evaluar({ ubicacion: MIRADOR, telefono: '+50497000009' });

    expect(r.reportes).toBe(1);
    expect(r.escalar).toBe(false);
  });
});
