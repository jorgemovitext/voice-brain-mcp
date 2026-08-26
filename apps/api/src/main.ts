import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './shared/logging.interceptor';

/**
 * Bootstrap del gateway HTTP (Fastify). El servidor MCP tiene su propio
 * bootstrap en src/mcp/mcp.bootstrap.ts (transporte stdio).
 */
async function bootstrap() {
  // rawBody: necesario para validar la firma X-Hub-Signature-256 de Meta.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    rawBody: true,
  });

  // Cookies de sesión (httpOnly) del módulo de auth.
  await app.register(fastifyCookie);

  /*
   * CORS con lista de orígenes conocidos, no espejo de cualquiera.
   *
   * `origin: true` refleja el Origin que llegue, y combinado con
   * `credentials: true` es una escopeta apuntando al pie: hoy la cookie
   * sameSite=lax lo contiene, pero el día que alguien la cambie a none (p.
   * ej. para embeber la consola), cualquier web podría leer respuestas
   * autenticadas. La consola se sirve del MISMO dominio que la API, así que
   * CORS solo hace falta para el dev server de Angular.
   */
  app.enableCors({
    origin: ['https://movihive.movitext.com', 'https://voice-brain-mcp.vercel.app', /^http:\/\/localhost:\d+$/],
    credentials: true,
  });
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`API lista en http://localhost:${port} (MOCK=${process.env.MOCK ?? 'true'})`);
}

void bootstrap();
