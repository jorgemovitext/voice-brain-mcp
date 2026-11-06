import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MedicionService } from '../facturacion/medicion.service';
import { CANALES, CATEGORIAS, NOMBRE_CANAL, NOMBRE_CATEGORIA, TarifaPorCanal } from '../facturacion/tarifas';
import { paises } from '../facturacion/paises';
import { SettingsService } from '../shared/settings.service';
import { PlataformaService } from './plataforma.service';
import { SoloPlataforma } from './plataforma.guard';

/**
 * El back-office de Movitext. TODO acá lleva `@SoloPlataforma`.
 *
 * Va en su propio módulo y no mezclado con lo del cliente porque es el
 * único lugar del sistema que cruza la línea del aislamiento: un endpoint
 * de acá sin su decorador es la fuga completa, no una fuga parcial.
 */

const listaSchema = z.object({
  paises: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  mercados: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  margen: z.number().min(0.1).max(20).optional(),
});
const tarifaSchema = z.record(z.enum(['whatsapp', 'sms', 'voz']), listaSchema);
const periodoSchema = /^\d{4}-\d{2}$/;

@SoloPlataforma()
@Controller('api/plataforma')
export class PlataformaController {
  constructor(
    private readonly plataforma: PlataformaService,
    private readonly medicion: MedicionService,
    private readonly settings: SettingsService,
  ) {}

  private periodo(valor?: string): string {
    if (!valor) return MedicionService.periodoDe();
    if (!periodoSchema.test(valor)) throw new BadRequestException('El período va como 2026-11.');
    return valor;
  }

  /** Todos los clientes, con su consumo y su margen del período. */
  @Get('clientes')
  async clientes(@Query('periodo') periodo?: string) {
    const p = this.periodo(periodo);
    const clientes = await this.plataforma.clientes(p);
    return {
      periodo: p,
      clientes,
      totales: {
        clientes: clientes.filter((c) => c.tipo === 'cliente').length,
        mensajes: clientes.reduce((t, c) => t + c.mensajes, 0),
        facturado: clientes.reduce((t, c) => t + c.facturado, 0),
        costo: clientes.reduce((t, c) => t + c.costo, 0),
      },
    };
  }

  /** La ficha de un cliente: su gente, sus números y su factura por país. */
  @Get('clientes/:id')
  async cliente(@Param('id') id: string, @Query('periodo') periodo?: string) {
    const ficha = await this.plataforma.cliente(id, this.periodo(periodo));
    if (!ficha) throw new BadRequestException('No encontramos ese cliente.');
    return ficha;
  }

  /**
   * El detalle crudo del período, en CSV.
   *
   * En CSV y no en JSON porque el destino es la facturación, que vive en
   * hojas de cálculo. Las columnas son las que ya se usan hoy.
   */
  @Get('clientes/:id/detalle.csv')
  async csv(
    @Param('id') id: string,
    @Query('periodo') periodo: string | undefined,
    @Res() res: FastifyReply,
  ) {
    const p = this.periodo(periodo);
    const filas = await this.plataforma.detalle(id, p);

    const cabecera = [
      'fecha', 'cliente_codigo', 'cliente', 'cuenta', 'canal', 'pais', 'prefijo',
      'telefono', 'tipo', 'cantidad', 'facturado_usd', 'costo_usd',
      'proveedor', 'operador_inicial', 'operador_final',
    ];
    const usd = (micros: number) => (micros / 1_000_000).toFixed(6);
    // Las comillas de un campo se escapan duplicándolas: un nombre de
    // cliente con comillas no puede romperle la columna a la contadora.
    const campo = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

    const lineas = [
      cabecera.join(','),
      ...filas.map((f) =>
        [
          f.fecha, f.clienteCodigo, f.cliente, f.cuenta, f.canal, f.pais, f.prefijo,
          f.telefono, f.tipo, f.cantidad, usd(f.facturado), usd(f.costo),
          f.proveedor, f.operadorInicial, f.operadorFinal,
        ].map(campo).join(','),
      ),
    ];

    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="consumo-${id}-${p}.csv"`)
      .send(lineas.join('\n'));
  }

  /** NUESTRA lista de precios: la que rige cuando el cliente no negoció. */
  @Get('tarifas')
  async tarifas() {
    return {
      plataforma: (await this.medicion.tarifaPlataforma()) ?? {},
      paises: paises(),
      canales: CANALES.map((c) => ({ id: c, nombre: NOMBRE_CANAL[c] })),
      categorias: CATEGORIAS.map((c) => ({ id: c, nombre: NOMBRE_CATEGORIA[c] })),
    };
  }

  @Patch('tarifas')
  async guardarTarifas(@Body() body: unknown) {
    const parsed = tarifaSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Las tarifas van por canal, en microdólares.');
    await this.settings.set('tarifas:plataforma', parsed.data as TarifaPorCanal);
    return { ok: true };
  }

  /** El precio negociado de UN cliente. Le gana a la lista general. */
  @Patch('clientes/:id/tarifas')
  async tarifaCliente(@Param('id') id: string, @Body() body: unknown) {
    const parsed = tarifaSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Las tarifas van por canal, en microdólares.');
    await this.settings.set(`tarifas:${id}`, parsed.data as TarifaPorCanal);
    return { ok: true };
  }
}
