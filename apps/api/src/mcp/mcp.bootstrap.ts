/**
 * Bootstrap del Brain como servidor MCP (transporte stdio).
 *
 * Corre como script propio (`npm run mcp`) y levanta el contexto Nest
 * SIN servidor HTTP (createApplicationContext) para reutilizar el mismo
 * BrainService y la misma persistencia que el gateway.
 *
 * Probar con:  npx @modelcontextprotocol/inspector npm run mcp
 *
 * OJO: en stdio, stdout es el canal del protocolo — todo log va a stderr
 * (por eso logger: false y console.error).
 */
import { NestFactory } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppModule } from '../app.module';
import { BrainService } from '../brain/brain.service';
import { registerBrainTools } from './tools';

async function main(): Promise<void> {
  // Contexto Nest sin HTTP; logger apagado para no ensuciar stdout.
  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const brain = appContext.get(BrainService);

  const server = new McpServer({
    name: 'voice-brain',
    version: '0.1.0',
  });

  registerBrainTools(server, brain);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Brain MCP server listo (stdio) — tools brain_* registradas');

  // TODO: transporte HTTP/SSE opcional — montar StreamableHTTPServerTransport
  // sobre el mismo `server` si se quiere exponer el Brain por red.
}

main().catch((err) => {
  console.error('[mcp] error fatal:', err);
  process.exit(1);
});
