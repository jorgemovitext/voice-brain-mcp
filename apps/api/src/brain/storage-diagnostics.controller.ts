import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { get, put } from '@vercel/blob';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';

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
    const modo = token ? 'vercel-blob' : 'archivo local (efímero en serverless)';

    const resultado: Record<string, unknown> = {
      modo,
      repositorio: this.repo.constructor.name,
      token: token ? { presente: true, largo: token.length, prefijo: token.slice(0, 12) } : { presente: false },
      pathname,
      contactosVisibles: (await this.repo.listContacts()).length,
    };

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

      const estado = await get(pathname, { token, useCache: false }).catch(() => null);
      resultado['estadoDelBrain'] = estado
        ? { existe: true, tamañoBytes: (await estado.text()).length }
        : { existe: false, nota: 'Todavía no se escribió el estado del Brain' };
    } catch (err) {
      resultado['escritura'] = { ok: false, error: (err as Error).message };
      resultado['diagnostico'] =
        'El token existe pero el store rechaza la escritura: por eso los datos solo viven en memoria.';
    }

    return resultado;
  }
}
