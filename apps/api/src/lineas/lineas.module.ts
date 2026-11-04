import { Module } from '@nestjs/common';
import { LineasController } from './lineas.controller';
import { LineasService } from './lineas.service';

/**
 * Las líneas: número de WhatsApp de cada cliente y agente que lo atiende.
 *
 * Se exporta el servicio porque el webhook entrante (ChannelsModule) enruta
 * cada mensaje por el número al que el ciudadano escribió.
 */
@Module({
  controllers: [LineasController],
  providers: [LineasService],
  exports: [LineasService],
})
export class LineasModule {}
