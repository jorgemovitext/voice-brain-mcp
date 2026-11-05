import { PAIS_DESCONOCIDO, paisDe } from './paises';
import { precioDe, tarifaDe } from './tarifas';

/*
 * El precio de un mensaje. Equivocarse acá no se ve como un error: se ve
 * como una factura que el cliente no paga, o como mensajes regalados que
 * nadie nota hasta cerrar el mes.
 */

describe('De qué país es un número', () => {
  it('reconoce Honduras', () => {
    expect(paisDe('+50433030235').iso).toBe('HN');
  });

  it('el prefijo MÁS LARGO gana: +1809 es Dominicana, no Estados Unidos', () => {
    /*
     * Es el caso que un emparejado ingenuo rompe. Con el primero que calce,
     * todo el Caribe se facturaría como Norteamérica — que es el grupo más
     * barato de la tabla.
     */
    expect(paisDe('+18095551234').iso).toBe('DO');
    expect(paisDe('+12125551234').iso).toBe('US');
  });

  it('acepta el número como lo escribe la gente', () => {
    expect(paisDe('504 9761-6546').iso).toBe('HN');
  });

  it('un número que no se ubica NO sale gratis: cae en el grupo más caro', () => {
    /*
     * La tentación es tratar lo desconocido como cero. Eso convierte
     * cualquier número raro en un mensaje regalado, y el error se descubre
     * cuando ya se mandaron miles.
     */
    const raro = paisDe('+99988877766');
    expect(raro.iso).toBe(PAIS_DESCONOCIDO.iso);

    const precio = precioDe(raro.iso, 'servicio');
    expect(precio).toBeGreaterThan(0);
    expect(precio).toBeGreaterThanOrEqual(tarifaDe('centroamerica').servicio);
  });

  it('sin número tampoco es gratis', () => {
    expect(precioDe(paisDe(undefined).iso, 'servicio')).toBeGreaterThan(0);
  });
});

describe('Cuánto cuesta un mensaje', () => {
  it('iniciar una conversación cuesta más que contestar', () => {
    // Es la diferencia que sostiene todo el módulo de seguimiento: si
    // costaran igual, dar un aviso de mañana sería gratis.
    expect(precioDe('HN', 'utilidad')).toBeGreaterThan(precioDe('HN', 'servicio'));
    expect(precioDe('HN', 'marketing')).toBeGreaterThan(precioDe('HN', 'utilidad'));
  });

  it('cada país tiene su precio', () => {
    expect(precioDe('ES', 'servicio')).not.toBe(precioDe('HN', 'servicio'));
  });

  it('la tarifa negociada por país le gana a la del grupo', () => {
    const negociada = {
      paises: { HN: { servicio: 9_000 } },
      grupos: { centroamerica: { servicio: 20_000 } },
    } as never;

    expect(precioDe('HN', 'servicio', negociada)).toBe(9_000);
    // Guatemala es del mismo grupo pero no tiene precio propio: hereda el
    // del grupo negociado, no el de Honduras.
    expect(precioDe('GT', 'servicio', negociada)).toBe(20_000);
  });

  it('una negociación PARCIAL no borra el resto de las categorías', () => {
    /*
     * Se negoció solo el precio de las respuestas. Si al guardar eso se
     * perdieran las demás, los avisos y las promociones pasarían a costar
     * cero: el cliente negociaría una categoría y se llevaría todas.
     */
    const negociada = { paises: { HN: { servicio: 1_000 } } } as never;

    expect(precioDe('HN', 'servicio', negociada)).toBe(1_000);
    expect(precioDe('HN', 'marketing', negociada)).toBe(tarifaDe('centroamerica').marketing);
  });
});
