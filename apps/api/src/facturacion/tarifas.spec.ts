import { mercadoDe, PAIS_DESCONOCIDO, paisDe } from './paises';
import { costoDe, costoMercado, MARGEN_POR_DEFECTO, precioDe } from './tarifas';

/*
 * El precio de un mensaje. Equivocarse acá no se ve como un error: se ve
 * como una factura que el cliente no paga, o como mensajes vendidos por
 * debajo de lo que nos cuestan.
 */

describe('De qué país es un número', () => {
  it('reconoce Honduras', () => {
    expect(paisDe('+50433030235').iso).toBe('HN');
  });

  it('Honduras NO tiene tarifa propia: va en «resto de Latinoamérica»', () => {
    /*
     * Es la parte contraintuitiva del modelo de Meta. Son 47 mercados: 39
     * países con tarifa propia y 8 regiones «resto de», y Centroamérica
     * entera cae en una de esas regiones. Inventarle una tarifa propia a
     * Honduras haría que nuestra factura no cuadre con la de Meta.
     */
    for (const t of ['+504', '+502', '+503', '+505', '+506', '+507']) {
      expect(paisDe(`${t}33030235`).mercado).toBe('latam');
    }
    // México sí la tiene, y es más barata.
    expect(paisDe('+5215512345678').mercado).toBe('mexico');
    expect(costoDe('MX', 'marketing')).toBeLessThan(costoDe('HN', 'marketing'));
  });

  it('el prefijo MÁS LARGO gana: +1809 es Dominicana, no Estados Unidos', () => {
    /*
     * Es el caso que un emparejado ingenuo rompe. Con el primero que calce,
     * el Caribe entero se facturaría como Norteamérica — el mercado más
     * barato de la tabla.
     */
    expect(paisDe('+18095551234').iso).toBe('DO');
    expect(paisDe('+18095551234').mercado).toBe('latam');
    expect(paisDe('+12125551234').mercado).toBe('norteamerica');
  });

  it('acepta el número como lo escribe la gente', () => {
    expect(paisDe('504 9761-6546').iso).toBe('HN');
  });

  it('un número que no se ubica se cobra al precio MÁS ALTO de la tabla', () => {
    /*
     * La tentación es tratar lo desconocido como cero o como el mercado de
     * casa. Cualquiera de las dos convierte un número raro en un mensaje
     * subsidiado, y el error se descubre cuando ya se mandaron miles.
     *
     * Que el techo se CALCULE del máximo de cada columna —y no se escriba a
     * mano— es lo que hace que siga siendo el techo cuando Meta suba una
     * tarifa.
     */
    const raro = paisDe('+99988877766');
    expect(raro.iso).toBe(PAIS_DESCONOCIDO.iso);
    expect(mercadoDe(raro.iso)).toBeNull();

    const todos = ['HN', 'MX', 'CO', 'BR', 'AR', 'CL', 'PE', 'US', 'ES', 'IN'];
    for (const iso of todos) {
      expect(costoDe(raro.iso, 'marketing')).toBeGreaterThanOrEqual(costoDe(iso, 'marketing'));
      expect(costoDe(raro.iso, 'servicio')).toBeGreaterThanOrEqual(costoDe(iso, 'servicio'));
    }
  });

  it('sin número tampoco es gratis', () => {
    expect(precioDe(paisDe(undefined).iso, 'servicio')).toBeGreaterThan(0);
  });
});

describe('Lo que cuesta y lo que se cobra', () => {
  it('la tarifa de Meta está cargada con los números de su tarjeta', () => {
    /*
     * Tarjeta vigente desde el 1 de octubre de 2026, en microdólares. Si
     * alguien la cambia sin querer —o si Meta publica una nueva y se
     * actualiza a medias—, esto lo dice.
     */
    expect(costoMercado('latam')!).toEqual({
      servicio: 11_300,
      utilidad: 11_300,
      autenticacion: 11_300,
      marketing: 74_000,
    });
    expect(costoMercado('mexico')!.marketing).toBe(39_700);
    expect(costoMercado('norteamerica')!.servicio).toBe(3_400);
    expect(costoMercado('colombia')!.servicio).toBe(800);
  });

  it('se vende por encima de lo que cuesta, nunca por debajo', () => {
    // Es la propiedad del negocio: vender un mensaje a pérdida no se nota
    // en uno, se nota en cincuenta mil.
    for (const iso of ['HN', 'MX', 'CO', 'BR', 'AR', 'CL', 'PE', 'US', 'ES', 'IN', 'ZZ']) {
      for (const c of ['servicio', 'utilidad', 'marketing'] as const) {
        expect(precioDe(iso, c)).toBeGreaterThan(costoDe(iso, c));
      }
    }
  });

  it('el precio de venta es el costo por el margen', () => {
    expect(precioDe('HN', 'servicio')).toBe(Math.round(11_300 * MARGEN_POR_DEFECTO));
  });

  it('iniciar una conversación cuesta más que contestar', () => {
    // Es la diferencia que sostiene el módulo de seguimiento: si costaran
    // igual, dar un aviso de mañana sería gratis.
    expect(costoDe('HN', 'marketing')).toBeGreaterThan(costoDe('HN', 'servicio'));
    expect(costoDe('MX', 'marketing')).toBeGreaterThan(costoDe('MX', 'utilidad'));
  });

  it('cada mercado tiene su precio', () => {
    expect(precioDe('ES', 'servicio')).not.toBe(precioDe('HN', 'servicio'));
    expect(precioDe('CO', 'servicio')).toBeLessThan(precioDe('PE', 'servicio'));
  });

  it('la tarifa negociada por país le gana a la del mercado', () => {
    const cliente = {
      whatsapp: { paises: { HN: { servicio: 9_000 } }, mercados: { latam: { servicio: 20_000 } } },
    } as never;

    expect(precioDe('HN', 'servicio', { cliente })).toBe(9_000);
    // Guatemala es del mismo mercado pero no tiene precio propio: hereda el
    // del mercado negociado, no el de Honduras.
    expect(precioDe('GT', 'servicio', { cliente })).toBe(20_000);
  });

  it('una negociación PARCIAL no borra el resto de las categorías', () => {
    /*
     * Se negoció solo el precio de las respuestas. Si al guardar eso se
     * perdieran las demás, los avisos y las promociones pasarían a costar
     * cero: el cliente negociaría una categoría y se llevaría todas.
     */
    const cliente = { whatsapp: { paises: { HN: { servicio: 1_000 } } } } as never;

    expect(precioDe('HN', 'servicio', { cliente })).toBe(1_000);
    expect(precioDe('HN', 'marketing', { cliente })).toBe(
      Math.round(costoDe('HN', 'marketing') * MARGEN_POR_DEFECTO),
    );
  });

  it('un margen propio cambia todos los precios de esa empresa', () => {
    const cliente = { whatsapp: { margen: 1.3 } } as never;
    expect(precioDe('HN', 'servicio', { cliente })).toBe(Math.round(11_300 * 1.3));
  });

  it('un margen de cero o negativo NO regala los mensajes', () => {
    // Un campo mal escrito en una configuración no puede poner la venta a
    // precio de costo, y mucho menos a cero.
    for (const margen of [0, -3]) {
      expect(precioDe('HN', 'servicio', { cliente: { whatsapp: { margen } } as never })).toBe(
        Math.round(11_300 * MARGEN_POR_DEFECTO),
      );
    }
  });
});
