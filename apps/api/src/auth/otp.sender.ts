import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';

/**
 * Entrega del código OTP por WhatsApp (el canal propio ya integrado vía
 * Gupshup). El código NUNCA viaja en la respuesta HTTP ni queda en la
 * bitácora visible de la consola; en modo MOCK se loguea solo en el server
 * para poder probar en local.
 */
@Injectable()
export class OtpSender {
  private readonly logger = new Logger(OtpSender.name);
  private readonly mock: boolean;

  constructor(
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
    config: ConfigService,
  ) {
    this.mock = config.get<boolean>('MOCK', true);
  }

  async send(phone: string, code: string, ttlMin: number): Promise<void> {
    const texto = `Tu código de acceso a Movitext es: ${code}. Vence en ${ttlMin} minutos. No lo compartas con nadie.`;

    if (this.mock) {
      // Solo desarrollo: visible en la terminal del server, jamás en la API.
      this.logger.log(`[MOCK] OTP para ${phone}: ${code}`);
      return;
    }

    // El adaptador real (Gupshup) expone envío directo por teléfono; el stub
    // de mock no siempre — se degrada a log de advertencia sin filtrar el código.
    const directo = this.whatsapp as ChannelPort & {
      sendToPhone?: (to: string, message: string) => Promise<unknown>;
    };
    if (typeof directo.sendToPhone === 'function') {
      await directo.sendToPhone(phone, texto);
      this.logger.log(`OTP enviado por WhatsApp a ${phone.slice(0, 6)}…`);
      return;
    }
    this.logger.warn(`No hay canal WhatsApp con envío directo: OTP a ${phone.slice(0, 6)}… no entregado`);
    throw new Error('Canal de entrega de OTP no disponible');
  }
}
