import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainModule } from '../brain/brain.module';
import { BrainService } from '../brain/brain.service';
import { CanalMedido } from '../facturacion/canal-medido';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { LimitesService } from '../facturacion/limites.service';
import { MedicionService } from '../facturacion/medicion.service';
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
  imports: [HttpModule, BrainModule, FacturacionModule],
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
      /*
       * El canal de WhatsApp sale SIEMPRE envuelto en la medición.
       *
       * Acá es el único lugar donde se decide qué adaptador atiende, así que
       * es el único lugar donde hace falta envolverlo: el que quiera mandar
       * un mensaje pide este token y queda medido sin saberlo. La
       * alternativa —acordarse de medir en cada uno de los siete lugares que
       * mandan mensajes— es un cobro que depende de la memoria de quien
       * escribe el próximo.
       */
      provide: WHATSAPP_CHANNEL,
      inject: [
        IntegrationsService,
        GupshupAdapter,
        WhatsappCloudAdapter,
        WhatsappAdapter,
        MedicionService,
        LimitesService,
        BrainService,
      ],
      useFactory: (
        integrations: IntegrationsService,
        gupshup: GupshupAdapter,
        cloud: WhatsappCloudAdapter,
        stub: WhatsappAdapter,
        medicion: MedicionService,
        limites: LimitesService,
        brain: BrainService,
      ) => {
        const provider = integrations.whatsappProvider();
        const real = provider === 'gupshup' ? gupshup : provider === 'cloud-api' ? cloud : stub;
        return new CanalMedido(real, medicion, limites, brain);
      },
    },
    // TODO: conectar un proveedor SMS real (Twilio/Infobip) igual que WhatsApp.
    // Cuando exista, va envuelto igual: un canal sin medir es un canal gratis.
    { provide: SMS_CHANNEL, useClass: SmsAdapter },
  ],
  exports: [IntegrationsService, WhatsappSignatureGuard, WHATSAPP_CHANNEL, SMS_CHANNEL],
})
export class IntegrationsModule {}
