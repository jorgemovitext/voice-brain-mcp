import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
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
    private readonly auth: AuthService,
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
  async atender(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const { tomar } = (body ?? {}) as { tomar?: unknown };
    if (typeof tomar !== 'boolean') {
      throw new BadRequestException('Falta `tomar` (true para tomarla, false para soltarla)');
    }
    if (!tomar) return this.atencion.liberar(id);

    return this.atencion.tomar(id, await this.operador(req));
  }

  /**
   * Nombre legible del operador. El `sub` del token es un UUID interno y en
   * la consola no se muestran identificadores, así que se resuelve contra la
   * cuenta: nombre, usuario o teléfono — lo primero que sirva para que otro
   * operador sepa quién tiene el hilo.
   */
  private async operador(
    req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ): Promise<string> {
    const sub = req.user?.sub;
    if (!sub) throw new BadRequestException('No se pudo identificar al operador');
    try {
      const yo = await this.auth.me(sub);
      const nombre = yo.name?.trim() || yo.username?.trim() || yo.phone?.trim();
      if (nombre) return nombre;
    } catch {
      // Cuenta borrada o token viejo: mejor un genérico que un UUID.
    }
    return req.user?.username?.trim() || 'un operador';
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
    const quien = await this.operador(req);
    const { operador } = await this.atencion.de(id);
    if (!operador) {
      throw new BadRequestException('Tomá la conversación antes de ejecutar acciones');
    }

    if (accion === 'crear-ticket') return this.ejecutor.crearTicket(id, quien);
    throw new BadRequestException(`Acción desconocida: ${accion}`);
  }
}
