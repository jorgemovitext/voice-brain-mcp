import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../shared/settings.service';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { MedicionService } from './medicion.service';
import { Funcion, Plan, plan as planPorId } from './planes';
import { Categoria } from './tarifas';

/**
 * Los topes: hasta dónde puede gastar una organización.
 *
 * Vender los mensajes trae un riesgo que el plan por sí solo no cubre: una
 * secuencia de seguimiento mal configurada manda miles de mensajes en una
 * tarde y la factura la descubre el cliente a fin de mes. Eso termina en un
 * cobro que no se paga y en un costo que igual pagamos nosotros.
 *
 * La decisión que ordena todo esto es la ASIMETRÍA entre contestar e
 * iniciar:
 *
 *  - Contestarle a alguien que acaba de escribir es EL servicio. Cortar eso
 *    por un tope es dejar a un vecino sin respuesta por una razón
 *    administrativa; el tope no se aplica ahí.
 *  - Iniciar una conversación —un seguimiento, un recordatorio, una
 *    promoción— es gasto discrecional nuestro. Ahí sí se corta.
 *
 * Con esa división, un tope agresivo no puede dejar muda una línea de
 * emergencias, y una secuencia desbocada se frena sola.
 *
 * La excepción es la prueba: sin plan pago no hay crédito, y al terminarse
 * la bolsa se corta todo. Alguien que no dio una forma de pago no puede
 * generar una deuda.
 */

export interface EstadoLimites {
  plan: Plan;
  periodo: string;
  mensajes: number;
  /** Lo que cuestan los mensajes del período, en microdólares. */
  micros: number;
  incluidos: number;
  /** Cuántos quedan de la bolsa. Cero cuando ya se pasó. */
  restantes: number;
  /** Mensajes por encima de la bolsa. */
  exceso: number;
  /** Tope de gasto en exceso que fijó el administrador. `null` = sin tope. */
  topeMicros: number | null;
  /** Lo que se cobraría hoy: el plan más el exceso. */
  totalMicros: number;
  /** Lo que se estima para el cierre del mes, al ritmo que va. */
  proyeccionMicros: number;
  /** ¿Se puede iniciar conversaciones? */
  puedeIniciar: boolean;
  /** ¿Se puede contestar? Solo la prueba agotada dice que no. */
  puedeResponder: boolean;
  motivo: 'bolsa-agotada' | 'tope-alcanzado' | null;
}

export interface Veredicto {
  ok: boolean;
  /** Para el log y para la pantalla. Vacío cuando `ok`. */
  motivo?: string;
}

interface AjustesFacturacion {
  /** Tope de gasto EN EXCESO, en microdólares. No incluye el plan. */
  topeMicros?: number | null;
}

@Injectable()
export class LimitesService {
  private readonly logger = new Logger(LimitesService.name);

  constructor(
    private readonly medicion: MedicionService,
    private readonly organizaciones: OrganizacionesService,
    private readonly settings: SettingsService,
  ) {}

  private clave(org: string): string {
    return `facturacion:${org}`;
  }

  async ajustes(org: string): Promise<AjustesFacturacion> {
    return (await this.settings.get<AjustesFacturacion>(this.clave(org))) ?? {};
  }

  async fijarTope(org: string, micros: number | null): Promise<AjustesFacturacion> {
    const actual = await this.ajustes(org);
    const nuevo: AjustesFacturacion = {
      ...actual,
      // Negativo sería «cortá todo»: eso se hace pausando la línea, no con un
      // tope, y un tope negativo por error dejaría la cuenta muda sin aviso.
      topeMicros: micros === null ? null : Math.max(0, Math.round(micros)),
    };
    await this.settings.set(this.clave(org), nuevo);
    this.logger.log(`Tope de gasto de ${org}: ${nuevo.topeMicros ?? 'sin tope'}`);
    return nuevo;
  }

  /** El plan de una organización. Sin base, el de prueba. */
  async planDe(org: string): Promise<Plan> {
    const ficha = await this.organizaciones.leer(org).catch(() => null);
    return planPorId(ficha?.plan);
  }

  async habilita(org: string, funcion: Funcion): Promise<boolean> {
    return (await this.planDe(org)).funciones.includes(funcion);
  }

  async estado(org: string): Promise<EstadoLimites> {
    const [plan, ajustes] = await Promise.all([this.planDe(org), this.ajustes(org)]);
    const periodo = MedicionService.periodoDe();
    const { mensajes, micros } = await this.medicion.consumo(org, periodo);

    const exceso = Math.max(0, mensajes - plan.mensajesIncluidos);
    const restantes = Math.max(0, plan.mensajesIncluidos - mensajes);

    /*
     * El costo del exceso no es «los mensajes de más por el precio
     * promedio»: son los mensajes de más por SU precio. Como la bolsa se
     * consume en orden, el exceso es lo que costaron los últimos `exceso`
     * mensajes del período — y eso lo sabe la medición, no una regla de
     * tres. Mientras no haya exceso, la cuenta es cero y no hace falta
     * preguntarle a la base.
     */
    const excesoMicros = exceso > 0 ? await this.costoDelExceso(org, periodo, plan.mensajesIncluidos) : 0;

    const tope = ajustes.topeMicros ?? null;
    const topeAlcanzado = tope !== null && excesoMicros >= tope;
    const bolsaAgotada = !plan.permiteExceso && mensajes >= plan.mensajesIncluidos;

    return {
      plan,
      periodo,
      mensajes,
      micros,
      incluidos: plan.mensajesIncluidos,
      restantes,
      exceso,
      topeMicros: tope,
      totalMicros: plan.precioMensual + excesoMicros,
      proyeccionMicros: plan.precioMensual + LimitesService.proyectar(excesoMicros),
      puedeIniciar: !bolsaAgotada && !topeAlcanzado,
      puedeResponder: !bolsaAgotada,
      motivo: bolsaAgotada ? 'bolsa-agotada' : topeAlcanzado ? 'tope-alcanzado' : null,
    };
  }

  /**
   * ¿Se puede mandar este mensaje?
   *
   * Nunca lanza: si no se puede averiguar el estado, deja pasar. Un error
   * leyendo la base no puede convertirse en un agente mudo — el riesgo de
   * cobrar un mensaje de más es menor que el de no contestarle a alguien.
   */
  async puedeEnviar(
    org: string,
    quien: { categoria?: Categoria; motivo?: string } = {},
  ): Promise<Veredicto> {
    try {
      const estado = await this.estado(org);
      const esRespuesta = (quien.motivo ?? 'respuesta') === 'respuesta' && (quien.categoria ?? 'servicio') === 'servicio';

      if (estado.motivo === 'bolsa-agotada') {
        return {
          ok: false,
          motivo: `Se acabaron los ${estado.incluidos} mensajes del plan ${estado.plan.nombre}.`,
        };
      }
      if (!esRespuesta && estado.motivo === 'tope-alcanzado') {
        return {
          ok: false,
          motivo: 'Se alcanzó el tope de gasto del mes: no se inician conversaciones nuevas.',
        };
      }
      return { ok: true };
    } catch (err) {
      this.logger.warn(`No se pudo revisar el tope de ${org}: ${(err as Error).message} — se deja pasar`);
      return { ok: true };
    }
  }

  /**
   * Lo que costaron los mensajes que pasaron de la bolsa.
   *
   * Se suman los que vinieron DESPUÉS de los incluidos, en orden de envío.
   * Con un promedio, un cliente que mandó mil mensajes baratos y diez caros
   * vería un exceso que no se parece a lo que mandó.
   */
  private async costoDelExceso(org: string, periodo: string, incluidos: number): Promise<number> {
    const detalle = await this.medicion.detalle(org, periodo);
    if (!detalle.mensajes || detalle.mensajes <= incluidos) return 0;
    /*
     * El detalle viene agrupado, no mensaje por mensaje: para repartir la
     * bolsa se recorre de lo más barato a lo más caro, que es lo que más le
     * conviene al cliente ante una duda. Que la duda se resuelva a su favor
     * es a propósito: el reclamo cuesta más que la diferencia.
     */
    const lineas = [...detalle.porPais].sort((a, b) => a.micros / a.mensajes - b.micros / b.mensajes);
    let porCubrir = incluidos;
    let exceso = 0;
    for (const l of lineas) {
      const unitario = l.micros / l.mensajes;
      const cubiertos = Math.min(porCubrir, l.mensajes);
      porCubrir -= cubiertos;
      exceso += (l.mensajes - cubiertos) * unitario;
    }
    return Math.round(exceso);
  }

  /** Al ritmo que va el mes, cuánto daría al cerrar. */
  private static proyectar(microsHastaHoy: number, ahora = new Date()): number {
    const dia = ahora.getUTCDate();
    const diasDelMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 0)).getUTCDate();
    if (dia < 1) return microsHastaHoy;
    return Math.round((microsHastaHoy / dia) * diasDelMes);
  }
}
