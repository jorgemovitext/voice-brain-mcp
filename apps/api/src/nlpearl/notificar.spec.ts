import { NlpearlWebhookController } from './webhook.controller';

/**
 * El flujo tiene 14 nodos de notificación y todos pegan al mismo endpoint con
 * un `tipo` distinto. Ese `tipo` se estaba ignorando: los cuatro cuerpos de
 * emergencia, el despacho del alcalde y el ciudadano recibían todos el mismo
 * "Tu reporte quedó registrado". Los bomberos, un acuse de recibo en vez de
 * una alerta.
 */
describe('El aviso se redacta según el tipo que pide el flujo', () => {
  // El redactor es privado a propósito: nadie más debería llamarlo.
  const redactar = (p: Record<string, unknown>, folio?: string) =>
    (NlpearlWebhookController as unknown as {
      redactarAviso(p: Record<string, unknown>, folio?: string): string;
    }).redactarAviso(p, folio);

  it('a los cuerpos de emergencia les manda la emergencia, no un acuse', () => {
    const texto = redactar(
      {
        tipo: 'alerta_emergencia',
        area: 'Bomberos',
        tipoProblema: 'Derrumbe',
        ubicacion: 'Barrio Los Jucos',
        descripcion: 'La ladera cedió y bloqueó el único paso.',
      },
      'L100-4791',
    );

    expect(texto).toContain('EMERGENCIA');
    expect(texto).toContain('Bomberos');
    expect(texto).toContain('Barrio Los Jucos');
    expect(texto).toContain('La ladera cedió');
    // Lo que salía antes y no correspondía.
    expect(texto).not.toContain('Tu reporte quedó registrado');
  });

  it('al despacho le manda el detalle y el comunicado como BORRADOR', () => {
    const texto = redactar({
      tipo: 'escalamiento_ejecutivo',
      detalleCompleto: 'Hundimiento en Comayagüela. Obstruye el paso.',
      reportesVinculados: '12',
      comunicadoBorrador: 'COMUNICADO AMDC: equipos en sitio.',
    });

    expect(texto).toContain('ESCALAMIENTO EJECUTIVO');
    expect(texto).toContain('Hundimiento en Comayagüela');
    expect(texto).toContain('12 reporte(s)');
    // Nunca se anuncia como publicado: lo autoriza una persona.
    expect(texto).toContain('Borrador de comunicado');
  });

  it('no menciona reportes vinculados cuando no hay otros', () => {
    const texto = redactar({ tipo: 'escalamiento_ejecutivo', tipoProblema: 'Bache', reportesVinculados: '0' });
    expect(texto).not.toContain('reporte(s) del mismo incidente');
  });

  it('al ciudadano le dice a qué gerencia fue su caso', () => {
    const texto = redactar({ tipo: 'ticket_hijo_asignado', area: 'Gerencia de Riesgos' }, 'L100-99');
    expect(texto).toContain('Gerencia de Riesgos');
    expect(texto).toContain('L100-99');
  });

  it('sin tipo sigue saliendo la confirmación de siempre', () => {
    const texto = redactar({}, 'L100-1');
    expect(texto).toContain('Tu reporte quedó registrado con el folio L100-1');
  });
});
