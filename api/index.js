/**
 * Función serverless de Vercel: monta el gateway NestJS (Fastify).
 *
 * Importa el build de `apps/api` (JavaScript ya compilado con tsc) en vez del
 * TypeScript fuente: el bundler de Vercel usa esbuild, que no emite la
 * metadata de decoradores que Nest necesita para inyectar dependencias.
 *
 * La instancia se cachea entre invocaciones para no re-bootear Nest en cada
 * request de una misma lambda caliente.
 */
const fastifyCookie = require('@fastify/cookie');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { AppModule } = require('../apps/api/dist/app.module');

let cachedServer;

async function bootstrap() {
  if (cachedServer) return cachedServer;

  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
    // rawBody: necesario para validar la firma de los webhooks de Meta.
    rawBody: true,
  });
  // Cookies de sesión (httpOnly) del módulo de auth.
  await app.register(fastifyCookie);
  app.enableCors({ origin: true, credentials: true });
  await app.init();

  const instance = adapter.getInstance();
  await instance.ready();
  cachedServer = instance;
  return cachedServer;
}

module.exports = async (req, res) => {
  const instance = await bootstrap();
  instance.server.emit('request', req, res);
};
