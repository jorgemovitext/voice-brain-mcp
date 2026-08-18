import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { SMS_CHANNEL, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { FollowupService } from './followup.service';
import { ChannelInboundController } from './inbound.controller';
import { SmsAdapter } from './sms.adapter';
import { WhatsappAdapter } from './whatsapp.adapter';

/**
 * Canales propios (WhatsApp/SMS). Los adaptadores se exponen por token
 * de puerto — cuando exista la WABA real, se cambia el useClass acá.
 */
@Module({
  imports: [BrainModule],
  controllers: [ChannelInboundController],
  providers: [
    FollowupService,
    { provide: WHATSAPP_CHANNEL, useClass: WhatsappAdapter },
    { provide: SMS_CHANNEL, useClass: SmsAdapter },
  ],
  exports: [FollowupService, WHATSAPP_CHANNEL, SMS_CHANNEL],
})
export class ChannelsModule {}
