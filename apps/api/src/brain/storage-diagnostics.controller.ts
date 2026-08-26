import { BadRequestException, Controller, Get, Inject, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { get, put } from '@vercel/blob';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { PgBrainRepository } from './brain.repository.pg';
import { Contact, Interaction, Signal } from './types';

/**
 * Diagnóstico de la persistencia: responde si el Brain está guardando de
 * verdad en un almacén compartido o solo en la memoria de la instancia.
 *
 * Existe porque el síntoma de "se pierden los contactos" puede venir de un
 * token ausente, de permisos, o de una escritura que falla en silencio, y
 * desde fuera los tres se ven igual.
 */
@Controller('api/integrations/storage')
export class StorageDiagnosticsController {
  constructor(
    private readonly config: ConfigService,
    @Inject(BRAIN_REPOSITORY) private readonly repo: BrainRepository,
  ) {}

  @Get()
  async status() {
    const token = this.config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    const pathname = this.config.get<string>('BRAIN_BLOB_PATH', 'brain/state.json');
    /*
     * El repositorio REAL manda sobre las variables: con Postgres conectado,
     * el token de Blob puede estar y no usarse. Antes esto miraba solo el
     * token y por eso decía "archivo local" en una instalación con Neon —
     * justo el diagnóstico que hace perder una tarde.
     */
    const clase = this.repo.constructor.name;
    const modo = clase.startsWith('Pg')
      ? 'postgres'
      : clase.startsWith('Blob')
        ? 'vercel-blob'
        : 'archivo local (efímero en serverless)';

    const resultado: Record<string, unknown> = {
      modo,
      repositorio: this.repo.constructor.name,
      token: token ? { presente: true, largo: token.length, prefijo: token.slice(0, 12) } : { presente: false },
      pathname,
      contactosVisibles: (await this.repo.listContacts()).length,
    };

    if (modo === 'postgres') {
      resultado['diagnostico'] = 'Postgres: el estado es compartido y sobrevive a los despliegues.';
      return resultado;
    }

    if (!token) {
      resultado['diagnostico'] = 'Sin token de Blob: el estado vive en /tmp y se pierde entre instancias.';
      return resultado;
    }

    // Escritura + lectura reales contra el store (privado, como está creado).
    try {
      const prueba = `diag/${Date.now()}.txt`;
      await put(prueba, `ok ${new Date().toISOString()}`, {
        access: 'private',
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });
      resultado['escritura'] = { ok: true };

      const estado = await get(pathname, { access: 'private', token, useCache: false }).catch(() => null);
      const texto = estado?.stream ? await new Response(estado.stream).text() : null;
      resultado['estadoDelBrain'] = texto
        ? { existe: true, tamañoBytes: texto.length }
        : { existe: false, nota: 'Todavía no se escribió el estado del Brain' };
    } catch (err) {
      resultado['escritura'] = { ok: false, error: (err as Error).message };
      resultado['diagnostico'] =
        'El token existe pero el store rechaza la escritura: por eso los datos solo viven en memoria.';
    }

    return resultado;
  }

  /**
   * Migración one-shot Blob → Postgres: copia el snapshot viejo del Blob a la
   * DB nueva para no perder los hilos existentes. Idempotente (upsert por id):
   * correrla dos veces no duplica nada.
   */
  @Post('migrate-blob')
  async migrateBlob() {
    if (!(this.repo instanceof PgBrainRepository)) {
      throw new BadRequestException('La migración solo aplica cuando la persistencia activa es Postgres.');
    }
    const token = this.config.get<string>('BLOB_READ_WRITE_TOKEN', '');
    if (!token) throw new BadRequestException('No hay token de Blob del cual migrar.');

    const pathname = this.config.get<string>('BRAIN_BLOB_PATH', 'brain/state.json');
    const estado = await get(pathname, { access: 'private', token, useCache: false }).catch(() => null);
    if (!estado?.stream) return { migrado: false, nota: 'El Blob no tiene estado guardado.' };

    const snapshot = JSON.parse(await new Response(estado.stream).text()) as {
      contacts?: Contact[];
      interactions?: Interaction[];
      signals?: Signal[];
    };

    let contacts = 0;
    let interactions = 0;
    let signals = 0;
    for (const c of snapshot.contacts ?? []) {
      await this.repo.saveContact(c);
      contacts++;
    }
    for (const i of snapshot.interactions ?? []) {
      await this.repo.appendInteraction(i); // pg: ON CONFLICT DO NOTHING
      interactions++;
    }
    for (const s of snapshot.signals ?? []) {
      await this.repo.saveSignal(s);
      signals++;
    }
    return { migrado: true, contacts, interactions, signals };
  }
}
