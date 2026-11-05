import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Requiere } from '../auth/permisos.guard';
import { Public } from '../auth/public.decorator';
import { SeguimientoService } from './seguimiento.service';

const configSchema = z.object({
  activas: z.record(z.string(), z.boolean()).optional(),
  maxPorPersonaSemana: z.number().int().min(1).max(3).optional(),
});

@Controller('api/seguimiento')
export class SeguimientoController {
  private readonly secretoCron: string;

  constructor(
    private readonly seguimiento: SeguimientoService,
    config: ConfigService,
  ) {
    this.secretoCron = config.get<string>('CRON_SECRET', '');
  }

  private org(req: FastifyRequest & { user?: { org?: string } }): string {
    const org = req.user?.org;
    if (!org) throw new BadRequestException('Tu cuenta no tiene empresa asignada.');
    return org;
  }

  /**
   * Las secuencias, su estado y lo que costarían.
   *
   * `personas` es cuánta gente se estima por mes: la pantalla lo mueve y el
   * costo se recalcula acá. Que el número salga del servidor y no de una
   * multiplicación en el navegador importa — el precio depende del país y
   * de la categoría de cada paso, y un promedio diría otra cosa que la
   * factura.
   */
  @Get()
  async panorama(
    @Query('personas') personas: string | undefined,
    @Req() req: FastifyRequest & { user?: { org?: string } },
  ) {
    const n = Math.min(10_000, Math.max(1, Number(personas) || 100));
    return this.seguimiento.panorama(this.org(req), n);
  }

  @Requiere('seguimiento:editar')
  @Patch()
  async guardar(@Body() body: unknown, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    const parsed = configSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Datos inválidos para el seguimiento.');
    return this.seguimiento.guardarConfig(this.org(req), parsed.data);
  }

  /**
   * La corrida: manda lo que toca. La dispara el cron de Vercel.
   *
   * Es pública por fuerza —un cron no tiene sesión— y por eso exige un
   * secreto. Sin `CRON_SECRET` configurado NO se abre: un endpoint que
   * manda mensajes de todos los clientes, accesible sin nada, es una
   * factura ajena esperando a que alguien lo descubra.
   */
  @Public()
  @Post('tick')
  async tick(@Req() req: FastifyRequest) {
    const enviado = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (!this.secretoCron || enviado !== this.secretoCron) {
      throw new ForbiddenException('Esta corrida necesita el secreto del cron.');
    }
    return this.seguimiento.correr();
  }
}
