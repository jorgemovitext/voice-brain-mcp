import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { BrainModule } from './brain/brain.module';
import { HubspotModule } from './hubspot/hubspot.module';
import { ChannelsModule } from './channels/channels.module';
import { AgentesModule } from './agentes/agentes.module';
import { ElevenLabsModule } from './elevenlabs/elevenlabs.module';
import { FacturacionModule } from './facturacion/facturacion.module';
import { DemoModule } from './demo/demo.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LineasModule } from './lineas/lineas.module';
import { NlpearlModule } from './nlpearl/nlpearl.module';
import { SeguimientoModule } from './seguimiento/seguimiento.module';
import { DatabaseModule } from './shared/database.module';
import { OrgInterceptor } from './shared/org.interceptor';
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
    FacturacionModule,
    HubspotModule,
    ChannelsModule,
    ElevenLabsModule,
    AgentesModule,
    LineasModule,
    NlpearlModule,
    SeguimientoModule,
    DemoModule,
  ],
  providers: [
    /*
     * Global: pone la organización de la sesión al alcance de toda la
     * petición. Va acá y no en cada controller porque olvidarlo en uno solo
     * sería una consulta sin filtro — y una consulta sin filtro es la fuga.
     */
    { provide: APP_INTERCEPTOR, useClass: OrgInterceptor },
  ],
})
export class AppModule {}
