import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/*
 * ¿Arranca la aplicación?
 *
 * Suena trivial y es el test que más falta hacía. Todos los demás construyen
 * los servicios a mano —`new WhatsappInboundService(...)` con dobles— y eso
 * NO toca el contenedor de dependencias de Nest. Así que un servicio que se
 * inyecta sin que ningún módulo lo provea pasa verde por toda la suite y
 * revienta al arrancar: no en una pantalla, no en un endpoint, la aplicación
 * entera.
 *
 * Ya pasó. Se enganchó el motor de traspaso al webhook, los 296 tests
 * quedaron en verde, y el módulo de canales inyectaba un servicio que
 * AgentesModule ni exportaba. En producción eso son todas las peticiones
 * fallando, no una función degradada.
 *
 * `compile()` resuelve el grafo completo sin abrir ningún puerto ni tocar la
 * red: es exactamente la comprobación que falta y cuesta un par de segundos.
 */

describe('La aplicación arranca', () => {
  /*
   * Sin DATABASE_URL a propósito: es el modo de desarrollo, donde cada
   * servicio degrada solo. Si el grafo resuelve así, resuelve con base.
   */
  const guardado = { ...process.env };

  beforeAll(() => {
    process.env.AUTH_JWT_SECRET = 'secreto-de-prueba-para-el-arranque';
    delete process.env.DATABASE_URL;
  });

  afterAll(() => {
    process.env = guardado;
  });

  it('resuelve TODAS las dependencias de todos los módulos', async () => {
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await modulo.close();
  }, 60_000);
});
