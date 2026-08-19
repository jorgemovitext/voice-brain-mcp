import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GupshupWebhookController } from '../integrations/whatsapp/gupshup.webhook.controller';
import { WhatsappWebhookController } from '../integrations/whatsapp/whatsapp.webhook.controller';
import { FollowupService } from './followup.service';
import { ChannelInboundController } from './inbound.controller';
import { WhatsappInboundService } from './whatsapp-inbound.service';

/**
 * Canales propios (WhatsApp/SMS): seguimiento saliente y entrada de mensajes.
 * Los adaptadores concretos los provee IntegrationsModule.
 */
@Module({
  imports: [BrainModule, IntegrationsModule],
  controllers: [ChannelInboundController, WhatsappWebhookController, GupshupWebhookController],
  providers: [FollowupService, WhatsappInboundService],
  // Se re-exporta el módulo (no los tokens): los canales los provee él.
  exports: [FollowupService, IntegrationsModule],
})
export class ChannelsModule {}
