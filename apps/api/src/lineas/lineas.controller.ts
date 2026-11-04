import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { LineasService } from './lineas.service';

/**
 * Las líneas de WhatsApp de los clientes: número + agente que atiende.
 *
 * Protegido por el guard global, como todo lo que no está marcado `@Public`:
 * acá se decide a qué agente le llegan los mensajes de un cliente.
 */
@Controller('api/lineas')
export class LineasController {
  constructor(private readonly lineas: LineasService) {}

  @Get()
  listar() {
    return this.lineas.listar();
  }

  @Post()
  crear(
    @Body()
    body: { cliente: string; nombre: string; numero: string; agente: string; destino?: string },
  ) {
    return this.lineas.crear(body ?? ({} as never));
  }

  @Patch(':id')
  async actualizar(
    @Param('id') id: string,
    @Body()
    body: Partial<{ cliente: string; nombre: string; agente: string; estado: 'activa' | 'pausada'; destino: string }>,
  ) {
    await this.lineas.actualizar(id, body ?? {});
    return { ok: true };
  }

  @Delete(':id')
  async eliminar(@Param('id') id: string) {
    await this.lineas.eliminar(id);
    return { ok: true };
  }
}
