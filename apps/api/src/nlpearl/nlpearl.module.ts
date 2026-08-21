import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainModule } from '../brain/brain.module';
import { ChannelsModule } from '../channels/channels.module';
import { VOICE_ENGINE_PORT } from '../ports/voice-engine.port';
import { NlpearlActivityStore } from './activity.store';
import { CallIngestService } from './call-ingest.service';
import { NlpearlDiagnosticsController } from './nlpearl-diagnostics.controller';
import { PearlSyncController } from './pearl-sync.controller';
import { PearlSyncService } from './pearl-sync.service';
import { NlpearlClient } from './nlpearl.client';
import { NlpearlVoiceEngine } from './nlpearl.engine';
import { PrecallService } from './precall.service';
import { NlpearlMockEngine } from './nlpearl.mock';
import { PrecallController } from './precall.controller';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { NlpearlWebhookController } from './webhook.controller';
import { WorkersController } from './workers.controller';

/**
 * Adaptador de voz. El binding mock/real del puerto vive ACÁ,
 * según MOCK — BrainModule y DemoModule nunca ven el cliente concreto.
 */
@Module({
  imports: [HttpModule, BrainModule, ChannelsModule],
  controllers: [
    PrecallController,
    NlpearlWebhookController,
    WorkersController,
    NlpearlDiagnosticsController,
    PearlSyncController,
  ],
  providers: [
    NlpearlClient,
    PrecallService,
    CallIngestService,
    NlpearlActivityStore,
    PearlSyncService,
    NlpearlMockEngine,
    NlpearlVoiceEngine,
    WebhookSignatureGuard,
    {
      provide: VOICE_ENGINE_PORT,
      inject: [ConfigService, NlpearlMockEngine, NlpearlVoiceEngine],
      useFactory: (config: ConfigService, mock: NlpearlMockEngine, real: NlpearlVoiceEngine) =>
        config.get<boolean>('MOCK') ? mock : real,
    },
  ],
  exports: [VOICE_ENGINE_PORT, NlpearlClient],
})
export class NlpearlModule {}
