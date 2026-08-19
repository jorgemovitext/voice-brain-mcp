import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRAIN_REPOSITORY } from './brain.repository';
import { BlobBrainRepository } from './brain.repository.blob';
import { JsonBrainRepository } from './brain.repository.json';
import { BrainController } from './brain.controller';
import { BrainService } from './brain.service';
import { IdentityService } from './identity.service';
import { StorageDiagnosticsController } from './storage-diagnostics.controller';

/**
 * BrainModule: el core. No importa clientes concretos de voz ni de
 * canales — solo su propio repositorio (intercambiable vía token).
 */
@Module({
  controllers: [BrainController, StorageDiagnosticsController],
  providers: [
    BrainService,
    IdentityService,
    BlobBrainRepository,
    JsonBrainRepository,
    {
      // Con un Blob store conectado el estado es compartido entre instancias
      // serverless; sin él, archivo local (suficiente para desarrollo).
      provide: BRAIN_REPOSITORY,
      inject: [ConfigService, BlobBrainRepository, JsonBrainRepository],
      useFactory: (config: ConfigService, blob: BlobBrainRepository, json: JsonBrainRepository) => {
        const usaBlob = !!config.get<string>('BLOB_READ_WRITE_TOKEN');
        new Logger('BrainModule').log(
          usaBlob ? 'Persistencia: Vercel Blob (compartida)' : 'Persistencia: archivo JSON local',
        );
        return usaBlob ? blob : json;
      },
    },
  ],
  exports: [BrainService, IdentityService, BRAIN_REPOSITORY],
})
export class BrainModule {}
