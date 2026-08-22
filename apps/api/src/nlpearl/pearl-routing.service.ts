import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '../brain/types';
import { SettingsService } from '../shared/settings.service';

/** Qué Pearl atiende cada canal. */
export type PearlRouting = Partial<Record<Channel, string>>;

const CLAVE = 'pearlRouting';

/**
 * Enrutamiento de Pearls: decide QUÉ Pearl usar en cada momento sin que el id
 * esté clavado en una variable de entorno.
 *
 * Orden de resolución:
 *   1. el `pearlId` que venga en la petición (elección explícita, puntual)
 *   2. la Pearl asignada a ese canal desde la app (persistida en la DB)
 *   3. `NLPEARL_PEARL_ID` del entorno, como respaldo heredado
 *
 * Así se puede alternar de Pearl con un clic, y una llamada concreta puede
 * pedir otra sin cambiarle la configuración a nadie.
 */
@Injectable()
export class PearlRoutingService {
  private readonly logger = new Logger(PearlRoutingService.name);
  private readonly fallbackEnv: string;

  constructor(
    private readonly settings: SettingsService,
    config: ConfigService,
  ) {
    this.fallbackEnv = config.get<string>('NLPEARL_PEARL_ID', '');
  }

  /** Mapa completo canal → pearlId, con el respaldo del entorno ya aplicado. */
  async all(): Promise<PearlRouting> {
    const guardado = (await this.settings.get<PearlRouting>(CLAVE)) ?? {};
    // El env solo cubre voz: era el único canal que existía cuando se definió.
    if (!guardado.voice && this.fallbackEnv) return { ...guardado, voice: this.fallbackEnv };
    return guardado;
  }

  /** Fuente de cada asignación, para poder explicarlo en la vista. */
  async withOrigin(): Promise<Array<{ channel: Channel; pearlId?: string; origin: 'app' | 'env' | 'sin asignar' }>> {
    const guardado = (await this.settings.get<PearlRouting>(CLAVE)) ?? {};
    const canales: Channel[] = ['voice', 'whatsapp', 'sms'];
    return canales.map((channel) => {
      if (guardado[channel]) return { channel, pearlId: guardado[channel], origin: 'app' as const };
      if (channel === 'voice' && this.fallbackEnv) {
        return { channel, pearlId: this.fallbackEnv, origin: 'env' as const };
      }
      return { channel, pearlId: undefined, origin: 'sin asignar' as const };
    });
  }

  /**
   * Pearl a usar. `override` gana siempre: permite disparar una llamada con
   * una Pearl distinta sin tocar la configuración.
   */
  async resolve(channel: Channel, override?: string): Promise<string> {
    if (override) return override;
    const pearlId = (await this.all())[channel];
    if (!pearlId) {
      throw new ServiceUnavailableException(
        `No hay un Pearl asignado al canal "${channel}". Elegí uno en la vista Obreros ` +
          '(botón "Usar para ' + channel + '") o mandá el pearlId en la petición.',
      );
    }
    return pearlId;
  }

  /** Asigna (o libera, con pearlId vacío) la Pearl de un canal. */
  async assign(channel: Channel, pearlId: string | null): Promise<PearlRouting> {
    const actual = (await this.settings.get<PearlRouting>(CLAVE)) ?? {};
    if (pearlId) actual[channel] = pearlId;
    else delete actual[channel];
    await this.settings.set(CLAVE, actual);
    this.logger.log(`Canal ${channel} → Pearl ${pearlId ?? '(sin asignar)'}`);
    return this.all();
  }
}
