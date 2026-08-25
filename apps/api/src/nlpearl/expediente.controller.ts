import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AtencionService } from './atencion.service';
import { EjecutarService } from './ejecutar.service';
import { ExpedienteService } from './expediente.service';

/**
 * GET /api/contacts/:id/expediente — resumen real del hilo y su caso en el CRM.
 *
 * Va aparte del contexto porque cambia mucho menos: el contexto se sondea cada
 * pocos segundos y esto consulta HubSpot. La consola lo refresca cada varias
 * vueltas, no en cada una.
 */
@Controller('api/contacts')
export class ExpedienteController {
  constructor(
    private readonly expediente: ExpedienteService,
    private readonly atencion: AtencionService,
    private readonly ejecutor: EjecutarService,
  ) {}

  @Get(':id/expediente')
  de(@Param('id') id: string) {
    return this.expediente.de(id);
  }

  /**
   * Tomar o soltar la conversación.
   *
   * El operador sale del token de sesión, no del cuerpo: quién atiende un
   * hilo no es algo que el cliente pueda declarar por su cuenta.
   */
  @Post(':id/atencion')
  atender(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const { tomar } = (body ?? {}) as { tomar?: unknown };
    if (typeof tomar !== 'boolean') {
      throw new BadRequestException('Falta `tomar` (true para tomarla, false para soltarla)');
    }
    if (!tomar) return this.atencion.liberar(id);

    const quien = req.user?.username ?? req.user?.sub;
    if (!quien) throw new BadRequestException('No se pudo identificar al operador');
    return this.atencion.tomar(id, quien);
  }

  /**
   * Ejecuta una de las acciones sugeridas. Solo con el hilo TOMADO: si lo
   * está atendiendo el agente, su flujo hace estas mismas cosas y ejecutarlas
   * acá crearía el ticket dos veces.
   */
  @Post(':id/acciones/:accion')
  async ejecutar(
    @Param('id') id: string,
    @Param('accion') accion: string,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const quien = req.user?.username ?? req.user?.sub;
    if (!quien) throw new BadRequestException('No se pudo identificar al operador');

    const { operador } = await this.atencion.de(id);
    if (!operador) {
      throw new BadRequestException('Tomá la conversación antes de ejecutar acciones');
    }

    if (accion === 'crear-ticket') return this.ejecutor.crearTicket(id, quien);
    throw new BadRequestException(`Acción desconocida: ${accion}`);
  }
}
