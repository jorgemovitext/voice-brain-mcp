import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemoService } from './demo.service';

/**
 * Siembra el directorio de demo al arrancar si el Brain está vacío.
 *
 * Importa sobre todo en serverless: cada instancia tiene su propia copia del
 * Brain (memoria + /tmp), así que sin esto un arranque en frío mostraría la
 * consola sin contactos. Los IDs sembrados son fijos, por lo que los enlaces
 * siguen siendo válidos entre instancias.
 */
@Injectable()
export class DemoSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoSeeder.name);

  constructor(private readonly demo: DemoService, private readonly config: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('SEED_ON_BOOT', true)) return;
    try {
      await this.demo.seedIfEmpty();
    } catch (err) {
      // Nunca impedir el arranque por el sembrado.
      this.logger.warn(`No se pudo sembrar la demo: ${(err as Error).message}`);
    }
  }
}
