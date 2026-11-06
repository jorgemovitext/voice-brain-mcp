import { BadRequestException, Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { Requiere } from '../auth/permisos.guard';
import { LimitesService } from './limites.service';
import { MedicionService } from './medicion.service';
import { NOMBRE_FUNCION, plan as planPorId, planesVisibles } from './planes';
import { paises } from './paises';
import { CATEGORIAS, NOMBRE_CATEGORIA, precioDe, TarifaPorCanal } from './tarifas';
import { SettingsService } from '../shared/settings.service';

/**
 * Uso y facturación.
 *
 * Todo lo de acá es del administrador: el consumo y el plan son del dueño del
 * negocio. Lleva `@Requiere` también en las LECTURAS —no solo en los
 * cambios— porque el default del guard deja leer a cualquiera con sesión, y
 * acá eso no alcanza.
 */

const planSchema = z.object({ plan: z.enum(['prueba', 'negocio', 'institucional']) });
/** El tope va en dólares, que es como lo piensa quien lo escribe. */
const topeSchema = z.object({ dolares: z.number().min(0).max(100_000).nullable() });
/** Una lista de precios: por país, por mercado, o un margen propio. */
const listaSchema = z.object({
  paises: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  mercados: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  margen: z.number().min(0.1).max(20).optional(),
});
/** Las tarifas van POR CANAL: `{ whatsapp: {...}, sms: {...} }`. */
const tarifaSchema = z.record(z.enum(['whatsapp', 'sms', 'voz']), listaSchema);

@Controller('api/facturacion')
export class FacturacionController {
  constructor(
    private readonly medicion: MedicionService,
    private readonly limites: LimitesService,
    private readonly organizaciones: OrganizacionesService,
    private readonly settings: SettingsService,
  ) {}

  private org(req: FastifyRequest & { user?: { org?: string } }): string {
    const org = req.user?.org;
    // Sin organización no se puede responder nada: devolver el consumo de
    // «todos» sería mostrarle a un cliente lo que gastan los demás.
    if (!org) throw new BadRequestException('Tu cuenta no tiene empresa asignada.');
    return org;
  }

  /**
   * El tablero de uso: lo que va del mes, cómo se reparte y qué se cobraría.
   *
   * Va en UNA lectura porque la pantalla necesita todo junto para decir algo
   * coherente: con llamadas sueltas, el total y el detalle se pintan en
   * momentos distintos y por un instante no suman lo mismo.
   */
  @Requiere('facturacion:ver')
  @Get('uso')
  async uso(@Req() req: FastifyRequest & { user?: { org?: string } }) {
    const org = this.org(req);
    const [estado, detalle, periodos, ultimos] = await Promise.all([
      this.limites.estado(org),
      this.medicion.detalle(org),
      this.medicion.periodos(org),
      this.medicion.ultimos(org, 40),
    ]);
    return { estado, detalle, periodos, ultimos, moneda: 'USD' };
  }

  /** Un mes cerrado, con los precios que tenía cuando se mandaron los mensajes. */
  @Requiere('facturacion:ver')
  @Get('uso/:periodo')
  async usoDe(@Param('periodo') periodo: string, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    if (!/^\d{4}-\d{2}$/.test(periodo)) throw new BadRequestException('El período va como 2026-11.');
    return this.medicion.detalle(this.org(req), periodo);
  }

  /** Los planes y en cuál está la empresa. */
  @Requiere('facturacion:ver')
  @Get('planes')
  async planes(@Req() req: FastifyRequest & { user?: { org?: string } }) {
    const org = this.org(req);
    const ficha = await this.organizaciones.leer(org).catch(() => null);
    const actual = planPorId(ficha?.plan);
    return {
      actual: actual.id,
      /*
       * El plan interno no se ofrece pero sí se nombra: si no apareciera,
       * la organización histórica vería «tu plan: Prueba» con topes que no
       * se le aplican.
       */
      enLista: planesVisibles().some((p) => p.id === actual.id),
      planes: planesVisibles(),
      nombreFuncion: NOMBRE_FUNCION,
      empresa: ficha?.nombre,
    };
  }

  @Requiere('facturacion:editar')
  @Patch('plan')
  async cambiarPlan(@Body() body: unknown, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    const parsed = planSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Ese plan no existe.');
    const org = this.org(req);
    await this.organizaciones.cambiarPlan(org, parsed.data.plan);
    return this.limites.estado(org);
  }

  /** El tope de gasto en exceso del mes. `null` lo quita. */
  @Requiere('facturacion:editar')
  @Patch('tope')
  async tope(@Body() body: unknown, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    const parsed = topeSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('El tope va en dólares, o null para quitarlo.');
    const org = this.org(req);
    await this.limites.fijarTope(
      org,
      parsed.data.dolares === null ? null : Math.round(parsed.data.dolares * 1_000_000),
    );
    return this.limites.estado(org);
  }

  /**
   * La tarifa: lo que cuesta un mensaje a cada país.
   *
   * Se muestra siempre, aunque el plan no permita negociarla: un cliente
   * tiene derecho a ver con qué número se le factura antes de que le llegue
   * la factura.
   */
  @Requiere('facturacion:ver')
  @Get('tarifas')
  async tarifas(@Req() req: FastifyRequest & { user?: { org?: string } }) {
    const org = this.org(req);
    const [cliente, plataforma] = await Promise.all([
      this.medicion.tarifaOrg(org),
      this.medicion.tarifaPlataforma(),
    ]);

    /*
     * Se devuelve el precio de VENTA país por país, ya resuelto, y nunca lo
     * que a nosotros nos cuesta el mensaje. El costo de Meta es nuestro
     * margen: publicarlo en una respuesta que el cliente puede abrir en el
     * navegador es entregarle la negociación hecha.
     */
    return {
      paises: paises().map((p) => ({
        iso: p.iso,
        nombre: p.nombre,
        precios: Object.fromEntries(
          CATEGORIAS.map((c) => [c, precioDe(p.iso, c, { canal: 'whatsapp', cliente, plataforma })]),
        ),
      })),
      categorias: CATEGORIAS.map((c) => ({ id: c, nombre: NOMBRE_CATEGORIA[c] })),
      puedeNegociar: await this.limites.habilita(org, 'tarifa-propia'),
      /** Desde cuándo rige la tarifa de Meta sobre la que se calcula. */
      vigenteDesde: '2026-10-01',
    };
  }

  @Requiere('facturacion:editar')
  @Patch('tarifas')
  async guardarTarifas(@Body() body: unknown, @Req() req: FastifyRequest & { user?: { org?: string } }) {
    const org = this.org(req);
    // La comprobación va en el servidor aunque la pantalla ya bloquee: un
    // plan que solo se respeta en el navegador no se respeta.
    if (!(await this.limites.habilita(org, 'tarifa-propia'))) {
      throw new BadRequestException('Negociar tarifas por país es del plan Institucional.');
    }
    const parsed = tarifaSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Las tarifas van en microdólares por mensaje.');
    await this.settings.set(`tarifas:${org}`, parsed.data as TarifaPorCanal);
    return { ok: true };
  }
}
