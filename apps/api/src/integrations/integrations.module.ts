import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainModule } from '../brain/brain.module';
import { SmsAdapter } from '../channels/sms.adapter';
import { WhatsappAdapter } from '../channels/whatsapp.adapter';
import { NlpearlClient } from '../nlpearl/nlpearl.client';
import { SMS_CHANNEL, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GupshupAdapter } from './whatsapp/gupshup.adapter';
import { WhatsappCloudAdapter } from './whatsapp/whatsapp-cloud.adapter';
import { WhatsappSignatureGuard } from './whatsapp/whatsapp-signature.guard';

/**
 * Integraciones con proveedores externos. Acá vive el binding de cada canal:
 * si hay credenciales de la Cloud API se usa WhatsApp real; si no, el stub que
 * registra en el log. Los módulos que consumen canales solo ven los tokens.
 */
@Module({
  imports: [HttpModule, BrainModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    // Solo para la prueba de conexión de esta vista; el motor de voz lo
    // provee NlpearlModule.
    NlpearlClient,
    WhatsappSignatureGuard,
    GupshupAdapter,
    WhatsappCloudAdapter,
    WhatsappAdapter,
    {
      provide: WHATSAPP_CHANNEL,
      inject: [IntegrationsService, GupshupAdapter, WhatsappCloudAdapter, WhatsappAdapter],
      useFactory: (
        integrations: IntegrationsService,
        gupshup: GupshupAdapter,
        cloud: WhatsappCloudAdapter,
        stub: WhatsappAdapter,
      ) => {
        const provider = integrations.whatsappProvider();
        if (provider === 'gupshup') return gupshup;
        return provider === 'cloud-api' ? cloud : stub;
      },
    },
    // TODO: conectar un proveedor SMS real (Twilio/Infobip) igual que WhatsApp.
    { provide: SMS_CHANNEL, useClass: SmsAdapter },
  ],
  exports: [IntegrationsService, WhatsappSignatureGuard, WHATSAPP_CHANNEL, SMS_CHANNEL],
})
export class IntegrationsModule {}
