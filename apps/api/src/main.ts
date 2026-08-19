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

  // CORS para la consola Angular (dev). El proxy de Angular también aplica.
  app.enableCors({ origin: true });
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`API lista en http://localhost:${port} (MOCK=${process.env.MOCK ?? 'true'})`);
}

void bootstrap();
