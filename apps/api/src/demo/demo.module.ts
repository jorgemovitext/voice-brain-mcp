import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { ChannelsModule } from '../channels/channels.module';
import { NlpearlModule } from '../nlpearl/nlpearl.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  imports: [BrainModule, ChannelsModule, NlpearlModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
