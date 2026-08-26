import { SettingsService } from '../shared/settings.service';
import { HandoffService } from './handoff.service';

/**
 * El rodeo para tomar una conversación en curso: la API v2 no expone
 * takeover, así que la petición viaja en la respuesta del siguiente avance
 * del flujo.
 */
describe('HandoffService', () => {
  const CONV = 'a1b2c3d4e5f6a7b8c9d0e1f2';

  function build() {
    const guardado = new Map<string, unknown>();
    const settings = {
      get: async (k: string) => guardado.get(k),
      set: async (k: string, v: unknown) => void guardado.set(k, v),
    };
    return new HandoffService(settings as unknown as SettingsService);
  }

  it('el flujo se entera en el siguiente avance', async () => {
    const h = build();
    expect(await h.reclamar(CONV)).toBe(false);

    await h.pedir(CONV, 'Jorge Murcia');

    expect(await h.reclamar(CONV)).toBe(true);
  });

  it('es de un solo uso: no deja al flujo rebotando contra el handoff', async () => {
    const h = build();
    await h.pedir(CONV, 'Jorge Murcia');

    expect(await h.reclamar(CONV)).toBe(true);
    // Los avances siguientes ya no lo piden.
    expect(await h.reclamar(CONV)).toBe(false);
    expect(await h.reclamar(CONV)).toBe(false);
  });

  it('una petición vieja caduca en vez de cortar la charla de golpe', async () => {
    const h = build();
    await h.pedir(CONV, 'Jorge Murcia');

    // Once minutos después: el operador la pidió y la conversación siguió.
    const ahora = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(ahora + 11 * 60_000);
    try {
      expect(await h.pendiente(CONV)).toBeNull();
      expect(await h.reclamar(CONV)).toBe(false);
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }
  });

  it('cada conversación lleva su propia petición', async () => {
    const h = build();
    await h.pedir(CONV, 'Jorge Murcia');

    expect(await h.reclamar('0000000000000000000000ff')).toBe(false);
    expect(await h.reclamar(CONV)).toBe(true);
  });
});
