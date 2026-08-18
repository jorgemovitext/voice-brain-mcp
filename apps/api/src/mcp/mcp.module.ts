import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';

/**
 * Módulo MCP. El servidor real corre como script aparte
 * (mcp.bootstrap.ts) sobre el contexto Nest completo; este módulo
 * existe como punto de extensión si se quiere montar un transporte
 * HTTP/SSE dentro del gateway.
 */
@Module({
  imports: [BrainModule],
})
export class McpModule {}
