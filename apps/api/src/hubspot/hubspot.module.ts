import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { HubspotClient } from './hubspot.client';
import { HubspotController } from './hubspot.controller';

/** Lectura del CRM para el panel de casos. Solo consulta, nunca escribe. */
@Module({
  imports: [BrainModule],
  controllers: [HubspotController],
  providers: [HubspotClient],
  exports: [HubspotClient],
})
export class HubspotModule {}
