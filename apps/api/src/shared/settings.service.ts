import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Pool } from 'pg';
import { ensureSchema, PG_POOL } from './database.module';

/**
 * Configuración que se edita desde la app (no desde variables de entorno).
 *
 * Existe porque hay ajustes que cambian seguido —qué Pearl atiende cada
 * canal, por ejemplo— y tocarlos por env obliga a un redeploy y a recordar
 * IDs a mano. Acá viven en la DB y se cambian con un clic.
 *
 * Sin Postgres cae a un archivo JSON local (desarrollo).
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly file: string;

  /** Caché corta: en serverless cada invocación relee, pero dentro de una
   *  misma request no tiene sentido volver a la DB. */
  private cache = new Map<string, { value: unknown; at: number }>();
  private static readonly FRESH_MS = 2_000;

  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    config: ConfigService,
  ) {
    const brainFile = config.get<string>('BRAIN_DATA_FILE', './data/brain.json');
    this.file = brainFile.replace(/[^/]+$/, 'settings.json');
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SettingsService.FRESH_MS) return hit.value as T;

    const value = this.pool ? await this.getFromDb<T>(key) : await this.getFromFile<T>(key);
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async set<T>(key: string, value: T): Promise<T> {
    if (this.pool) {
      await ensureSchema(this.pool);
      await this.pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    } else {
      const todo = await this.readFile();
      todo[key] = value;
      await fs.mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
      await fs.writeFile(this.file, JSON.stringify(todo, null, 2));
    }
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  private async getFromDb<T>(key: string): Promise<T | undefined> {
    try {
      await ensureSchema(this.pool!);
      const res = await this.pool!.query('SELECT value FROM app_settings WHERE key = $1', [key]);
      return res.rows[0]?.value as T | undefined;
    } catch (err) {
      this.logger.warn(`No se pudo leer la configuración "${key}": ${(err as Error).message}`);
      return undefined;
    }
  }

  private async getFromFile<T>(key: string): Promise<T | undefined> {
    return (await this.readFile())[key] as T | undefined;
  }

  private async readFile(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
