import { Module } from '@nestjs/common';
import { BRAIN_REPOSITORY } from './brain.repository';
import { JsonBrainRepository } from './brain.repository.json';
import { BrainController } from './brain.controller';
import { BrainService } from './brain.service';
import { IdentityService } from './identity.service';

/**
 * BrainModule: el core. No importa clientes concretos de voz ni de
 * canales — solo su propio repositorio (intercambiable vía token).
 */
@Module({
  controllers: [BrainController],
  providers: [
    BrainService,
    IdentityService,
    // Cambiar useClass por una impl. SQLite/Postgres cuando toque.
    { provide: BRAIN_REPOSITORY, useClass: JsonBrainRepository },
  ],
  exports: [BrainService, IdentityService, BRAIN_REPOSITORY],
})
export class BrainModule {}
