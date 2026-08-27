import { Controller, Get, Logger, NotFoundException, Param, Res } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';
import { firstValueFrom } from 'rxjs';
import { BrainService } from '../brain/brain.service';

/**
 * Sirve al operador el archivo que un ciudadano mandó por WhatsApp.
 *
 * Gupshup no expone una descarga por mediaId: entrega una URL directa a su
 * filemanager en el webhook (ver `WhatsappInboundService.urlDeMedia`), que
 * guardamos en `attachmentUrl`. Este endpoint la baja del lado del servidor y
 * la reenvía, en vez de que el navegador pegue directo. Tres razones:
 *
 *  - La apikey de Gupshup queda del lado del servidor: la doc no aclara si el
 *    filemanager es público, así que se manda por las dudas y nunca sale al
 *    navegador.
 *  - El enlace es del MISMO origen y pasa por la sesión: solo un operador
 *    con sesión ve la media de un ciudadano (es dato personal).
 *  - Si la URL de Gupshup vence, el fallo se ve acá y no como un enlace roto.
 */
@Controller('api/media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);
  private readonly apiKey: string;

  constructor(
    private readonly brain: BrainService,
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('GUPSHUP_API_KEY', '');
  }

  /**
   * `id` es el de la INTERACCIÓN, no la URL cruda: así no se puede usar este
   * proxy para bajar cualquier URL arbitraria, solo la del archivo que de
   * verdad está guardado en un hilo.
   */
  @Get(':id')
  async media(@Param('id') id: string, @Res() res: FastifyReply): Promise<void> {
    const interaccion = await this.brain.getInteraction(id);
    const url = interaccion?.attachmentUrl;
    if (!url) throw new NotFoundException('Ese mensaje no tiene un archivo para descargar');

    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          responseType: 'arraybuffer',
          // Sin apikey si no hay: un filemanager público la ignora.
          headers: this.apiKey ? { apikey: this.apiKey } : {},
          // El archivo del ciudadano no debería ser enorme; se acota igual.
          maxContentLength: 25 * 1024 * 1024,
          timeout: 15_000,
        }),
      );
      const tipo = (resp.headers['content-type'] as string) ?? 'application/octet-stream';
      res
        .header('content-type', tipo)
        // Se puede cachear en el navegador: la media de un mensaje no cambia.
        .header('cache-control', 'private, max-age=3600')
        .send(Buffer.from(resp.data as ArrayBuffer));
    } catch (err) {
      // Lo más común es que la URL de Gupshup haya vencido (urlExpiry).
      this.logger.warn(`No se pudo traer la media de ${id}: ${(err as Error).message}`);
      throw new NotFoundException('El archivo ya no está disponible en WhatsApp (el enlace pudo vencer)');
    }
  }
}
