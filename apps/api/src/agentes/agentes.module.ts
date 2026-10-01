import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ElevenLabsModule } from '../elevenlabs/elevenlabs.module';
import { AgentesController } from './agentes.controller';
import { AgentesService } from './agentes.service';
import { AsistenteAgentesService } from './asistente.service';
import { aceptarArchivosCrudos, DocumentosService } from './documentos.service';

/**
 * Administración de los agentes conversacionales.
 *
 * Depende de ElevenLabsModule solo por el cliente del WebSocket, que es lo que
 * deja probar un agente desde el editor. La gestión (crear, editar, herramientas,
 * contexto) va por REST y no comparte nada con el motor que atiende WhatsApp.
 */
@Module({
  imports: [ElevenLabsModule],
  controllers: [AgentesController],
  providers: [AgentesService, AsistenteAgentesService, DocumentosService],
  exports: [AgentesService],
})
export class AgentesModule implements OnModuleInit {
  constructor(private readonly adaptador: HttpAdapterHost) {}

  /**
   * Habilita la subida de archivos en cuanto el módulo arranca.
   *
   * Va acá y no en el bootstrap a propósito: hay DOS arranques —`main.ts` en
   * local y `api/index.js` en Vercel— y lo que se registra en uno se olvida en
   * el otro. Colgado del módulo que lo necesita, viaja con él.
   */
  onModuleInit(): void {
    const fastify = this.adaptador.httpAdapter?.getInstance?.();
    if (fastify?.addContentTypeParser) aceptarArchivosCrudos(fastify);
  }
}
