import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { get } from '@vercel/blob';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { PgBrainRepository } from './brain.repository.pg';
import { Contact, Interaction, Signal } from './types';

/**
 * Import automático Blob → Postgres en el arranque: cubre el cambio de
 * persistencia sin perder los hilos existentes y sin intervención manual
 * (los endpoints están detrás del auth, así que un import por endpoint
 * exigiría sesión).
 *
 * Corre solo si la persistencia activa es Postgres, la tabla de contactos
 * está VACÍA y el Blob tiene estado. Después del primer import el chequeo
 * cuesta un solo query por cold start.
 */
@Injectable()
export class BlobImportService implements OnModuleInit {
  private readonly logger = new Logger(BlobImportService.name);

  constructor(
    @Inject(BRAIN_REPOSITORY) private readonly repo: BrainRepository,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.importIfEmpty();
    } catch (err) {
      // Nunca frenar el arranque por esto.
      this.logger.warn(`Import Blob→Postgres omitido: ${(err as Error).message}`);
    }
  }

  private async importIfEmpty(): Promise<void> {
    if (!(this.repo instanceof PgBrainRepository)) return;
    const token = this.config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    if (!token) return;
    const existentes = (await this.repo.listContacts()).length;
    if (existentes > 0) {
      this.logger.log(`Postgres ya tiene ${existentes} contactos: no se importa del Blob`);
      return;
    }

    const pathname = this.config.get<string>('BRAIN_BLOB_PATH', 'brain/state.json');
    const estado = await get(pathname, { access: 'private', token, useCache: false }).catch(() => null);
    if (!estado?.stream) return;

    const snapshot = JSON.parse(await new Response(estado.stream).text()) as {
      contacts?: Contact[];
      interactions?: Interaction[];
      signals?: Signal[];
    };
    if (!snapshot.contacts?.length) return;

    for (const c of snapshot.contacts) await this.repo.saveContact(c);
    for (const i of snapshot.interactions ?? []) await this.repo.appendInteraction(i);
    for (const s of snapshot.signals ?? []) await this.repo.saveSignal(s);

    this.logger.log(
      `Blob→Postgres: importados ${snapshot.contacts.length} contactos, ` +
        `${snapshot.interactions?.length ?? 0} interacciones, ${snapshot.signals?.length ?? 0} señales`,
    );
  }
}
