import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { BrainModule } from './brain/brain.module';
import { HubspotModule } from './hubspot/hubspot.module';
import { ChannelsModule } from './channels/channels.module';
import { AgentesModule } from './agentes/agentes.module';
import { ElevenLabsModule } from './elevenlabs/elevenlabs.module';
import { DemoModule } from './demo/demo.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { NlpearlModule } from './nlpearl/nlpearl.module';
import { DatabaseModule } from './shared/database.module';
import { SharedModule } from './shared/flow-log.service';

/**
 * Ensambla los módulos. El servidor MCP reutiliza este mismo módulo
 * vía NestFactory.createApplicationContext (ver mcp/mcp.bootstrap.ts).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Busca .env en la raíz del monorepo y en apps/api
      envFilePath: ['../../.env', '.env'],
      validate: validateConfig,
    }),
    DatabaseModule,
    SharedModule,
    AuthModule,
    BrainModule,
    IntegrationsModule,
    HubspotModule,
    ChannelsModule,
    ElevenLabsModule,
    AgentesModule,
    NlpearlModule,
    DemoModule,
  ],
})
export class AppModule {}
