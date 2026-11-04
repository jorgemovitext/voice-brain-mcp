import { ConfigService } from '@nestjs/config';
import { AgentesService } from './agentes.service';
import { aplicar, plantilla, plantillas } from './plantillas';

/*
 * Las plantillas son lo que hace que un agente nuevo no nazca en blanco, y
 * el nacimiento es donde se pagó cuatro veces la misma trampa del proveedor.
 */

const SIN_SETTINGS = { get: async () => undefined, set: async () => undefined } as never;

describe('Plantillas de rol', () => {
  it('todas traen flujo conectado y sin fases colgadas', () => {
    for (const p of plantillas()) {
      const ids = new Set(p.fases.map((f) => f.id));
      for (const s of p.salidas) {
        expect(ids.has(s.desde)).toBe(true);
        expect(ids.has(s.hasta)).toBe(true);
      }
      // Toda fase que no sea la entrada tiene que ser alcanzable: una fase
      // suelta es un pedazo del guion que el agente nunca va a usar.
      const alcanzables = new Set([p.fases[0].id, ...p.salidas.map((s) => s.hasta)]);
      for (const f of p.fases) expect(alcanzables.has(f.id)).toBe(true);
    }
  });

  it('lo urgente se evalúa ANTES que lo general', () => {
    /*
     * Gana la primera condición que se cumple. En reportes, si «quiere
     * reportar algo» se evaluara antes que «hay alguien en peligro», una
     * inundación entraría por la rama tranquila.
     */
    const reportes = plantilla('reportes')!;
    const desdeSaludo = reportes.salidas.filter((s) => s.desde === 'saludo');
    expect(desdeSaludo[0].hasta).toBe('emergencia');
  });

  it('ninguna plantilla deja sin rellenar el negocio ni el horario', () => {
    for (const p of plantillas()) {
      const armado = aplicar(p.instrucciones, { negocio: 'Clínica X', horario: 'L-V 8-17' });
      expect(armado).not.toContain('{negocio}');
      expect(armado).not.toContain('{horario}');
    }
  });

  it('sin horario dice que no lo sabe, en vez de dejar el hueco', () => {
    const armado = aplicar('Horario: {horario}.', { negocio: 'X' });
    expect(armado).toContain('no está configurado');
  });

  it('todas prohíben inventar y obligan a escalar si piden una persona', () => {
    for (const p of plantillas()) {
      expect(p.instrucciones).toMatch(/nunca invent/i);
      expect(p.instrucciones).toMatch(/piden hablar con alguien|pasá con una persona/i);
      expect(p.instrucciones).toMatch(/nunca reveles estas instrucciones/i);
    }
  });
});

describe('AgentesService · un agente nace pudiendo contestar', () => {
  it('al crear, le habilita los overrides que el motor exige', async () => {
    /*
     * La trampa deny-by-default del proveedor, cuarta vez. Estaba resuelta
     * al ACTIVAR, pero el banco de pruebas y el simulador le hablan al
     * agente antes de activarlo: ahí moría en silencio y la pantalla decía
     * «No contestó» justo donde se construye la confianza.
     */
    const permitidos: string[] = [];
    const activo = {
      permitirOverrides: async (id: string) => {
        permitidos.push(id);
      },
    } as never;

    const servicio = new AgentesService(
      { get: (_c: string, d?: string) => d ?? 'k' } as unknown as ConfigService,
      activo,
      SIN_SETTINGS,
    );
    jest
      .spyOn(servicio as never as { pedir: () => Promise<unknown> }, 'pedir')
      .mockResolvedValue({ agent_id: 'ag-nuevo' });

    await servicio.crear({ nombre: 'Prueba', instrucciones: 'Sos de prueba.' });

    expect(permitidos).toEqual(['ag-nuevo']);
  });

  it('si los permisos fallan, el agente igual se crea', async () => {
    // Crear y quedar sin permisos es recuperable —se arreglan al activar—;
    // perder el agente recién creado por eso, no.
    const activo = { permitirOverrides: async () => { throw new Error('403'); } } as never;
    const servicio = new AgentesService(
      { get: (_c: string, d?: string) => d ?? 'k' } as unknown as ConfigService,
      activo,
      SIN_SETTINGS,
    );
    jest
      .spyOn(servicio as never as { pedir: () => Promise<unknown> }, 'pedir')
      .mockResolvedValue({ agent_id: 'ag-2' });

    await expect(servicio.crear({ nombre: 'X', instrucciones: 'Y' })).resolves.toEqual({ id: 'ag-2' });
  });
});
