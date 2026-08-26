import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainModule } from '../brain/brain.module';
import { ChannelsModule } from '../channels/channels.module';
import { VOICE_ENGINE_PORT } from '../ports/voice-engine.port';
import { NlpearlActivityStore } from './activity.store';
import { CallIngestService } from './call-ingest.service';
import { HiveController } from './hive.controller';
import { AuthModule } from '../auth/auth.module';
import { HubspotModule } from '../hubspot/hubspot.module';
import { AnalyticsController } from './analytics.controller';
import { ExpedienteController } from './expediente.controller';
import { ExpedienteService } from './expediente.service';
import { ResumenService } from './resumen.service';
import { AtencionService } from './atencion.service';
import { AccionesService } from './acciones.service';
import { EjecutarService } from './ejecutar.service';
import { EscalamientoService } from './escalamiento.service';
import { HandoffService } from './handoff.service';
import { AnalyticsService } from './analytics.service';
import { HiveService } from './hive.service';
import { NlpearlDiagnosticsController } from './nlpearl-diagnostics.controller';
import { PearlRoutingService } from './pearl-routing.service';
import { PearlSyncController } from './pearl-sync.controller';
import { PearlSyncService } from './pearl-sync.service';
import { NlpearlClient } from './nlpearl.client';
import { NlpearlVoiceEngine } from './nlpearl.engine';
import { PrecallService } from './precall.service';
import { NlpearlMockEngine } from './nlpearl.mock';
import { PrecallController } from './precall.controller';
import { TurnCredentialGuard } from './turn-credential.guard';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { NlpearlWebhookController } from './webhook.controller';
import { WorkersController } from './workers.controller';

/**
 * Adaptador de voz. El binding mock/real del puerto vive ACÁ,
 * según MOCK — BrainModule y DemoModule nunca ven el cliente concreto.
 */
@Module({
  imports: [HttpModule, BrainModule, ChannelsModule, HubspotModule, AuthModule],
  controllers: [
    PrecallController,
    NlpearlWebhookController,
    WorkersController,
    NlpearlDiagnosticsController,
    PearlSyncController,
    HiveController,
    AnalyticsController,
    ExpedienteController,
  ],
  providers: [
    NlpearlClient,
    PrecallService,
    CallIngestService,
    NlpearlActivityStore,
    PearlRoutingService,
    PearlSyncService,
    HiveService,
    AnalyticsService,
    ExpedienteService,
    ResumenService,
    AtencionService,
    AccionesService,
    EjecutarService,
    EscalamientoService,
    HandoffService,
    NlpearlMockEngine,
    NlpearlVoiceEngine,
    WebhookSignatureGuard,
    TurnCredentialGuard,
    {
      provide: VOICE_ENGINE_PORT,
      inject: [ConfigService, NlpearlMockEngine, NlpearlVoiceEngine],
      useFactory: (config: ConfigService, mock: NlpearlMockEngine, real: NlpearlVoiceEngine) =>
        config.get<boolean>('MOCK') ? mock : real,
    },
  ],
  exports: [VOICE_ENGINE_PORT, NlpearlClient, PearlRoutingService],
})
export class NlpearlModule {}
