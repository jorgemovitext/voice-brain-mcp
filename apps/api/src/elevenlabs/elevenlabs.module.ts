import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { HubspotModule } from '../hubspot/hubspot.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AgenteToolsService } from './agente-tools.service';
import { ElevenLabsController } from './elevenlabs.controller';
import { ElevenLabsVozService } from './elevenlabs-voz.service';
import { ElevenLabsClient } from './elevenlabs.client';
import { ElevenLabsService } from './elevenlabs.service';

/**
 * El motor conversacional. Se exporta entero para que los canales —hoy
 * WhatsApp, mañana voz— lo usen sin conocer el WebSocket que hay debajo.
 */
@Module({
  imports: [HttpModule, BrainModule, HubspotModule, IntegrationsModule],
  controllers: [ElevenLabsController],
  providers: [ElevenLabsClient, ElevenLabsService, AgenteToolsService, ElevenLabsVozService],
  exports: [ElevenLabsClient, ElevenLabsService, AgenteToolsService, ElevenLabsVozService],
})
export class ElevenLabsModule {}
