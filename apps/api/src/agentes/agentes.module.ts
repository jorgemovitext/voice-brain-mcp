import { Module } from '@nestjs/common';
import { ElevenLabsModule } from '../elevenlabs/elevenlabs.module';
import { AgentesController } from './agentes.controller';
import { AgentesService } from './agentes.service';

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
  providers: [AgentesService],
  exports: [AgentesService],
})
export class AgentesModule {}
