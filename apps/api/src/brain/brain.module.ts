import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRAIN_REPOSITORY } from './brain.repository';
import { BlobBrainRepository } from './brain.repository.blob';
import { JsonBrainRepository } from './brain.repository.json';
import { PgBrainRepository } from './brain.repository.pg';
import { BlobImportService } from './blob-import.service';
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
    BlobImportService,
    PgBrainRepository,
    BlobBrainRepository,
    JsonBrainRepository,
    {
      // Prioridad: Postgres (relacional, concurrencia real) > Blob (snapshot
      // compartido) > archivo JSON local (desarrollo).
      provide: BRAIN_REPOSITORY,
      inject: [ConfigService, PgBrainRepository, BlobBrainRepository, JsonBrainRepository],
      useFactory: (
        config: ConfigService,
        pg: PgBrainRepository,
        blob: BlobBrainRepository,
        json: JsonBrainRepository,
      ) => {
        const logger = new Logger('BrainModule');
        if (config.get<string>('DATABASE_URL')) {
          logger.log('Persistencia: Postgres (Neon)');
          return pg;
        }
        if (config.get<string>('BLOB_READ_WRITE_TOKEN')) {
          logger.log('Persistencia: Vercel Blob (compartida)');
          return blob;
        }
        logger.log('Persistencia: archivo JSON local');
        return json;
      },
    },
  ],
  exports: [BrainService, IdentityService, BRAIN_REPOSITORY],
})
export class BrainModule {}
