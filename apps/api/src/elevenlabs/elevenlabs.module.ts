import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { ElevenLabsClient } from './elevenlabs.client';
import { ElevenLabsService } from './elevenlabs.service';

/**
 * El motor conversacional. Se exporta entero para que los canales —hoy
 * WhatsApp, mañana voz— lo usen sin conocer el WebSocket que hay debajo.
 */
@Module({
  imports: [HttpModule, BrainModule],
  providers: [ElevenLabsClient, ElevenLabsService],
  exports: [ElevenLabsClient, ElevenLabsService],
})
export class ElevenLabsModule {}
