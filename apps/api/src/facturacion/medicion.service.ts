import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { orgActual } from '../shared/contexto-org';
import { SettingsService } from '../shared/settings.service';
import { ensureSchema, PG_POOL } from '../shared/database.module';
import { nombrePais, paisDe } from './paises';
import { Categoria, canalValido, costoDe, precioDe, TarifaPorCanal } from './tarifas';

/**
 * La medición: una fila por cada mensaje que sale.
 *
 * Es la pieza que convierte «vendemos los mensajes» en algo cobrable. Sin
 * esto el modelo de negocio es una intención: se mandan mensajes, nadie sabe
 * cuántos ni a dónde, y al final del mes la factura se arma a ojo.
 *
 * Dos decisiones que no son obvias y que importan más que el resto:
 *
 *  1. El PRECIO SE CONGELA en la fila. Lo que se cobra es lo que valía
 *     cuando el mensaje salió, no lo que vale hoy. Si se recalculara al
 *     leer, cambiar una tarifa reescribiría las facturas de los meses
 *     cerrados — y un cliente que compara dos PDF se da cuenta.
 *
 *  2. Medir NO puede tumbar un envío. Si la base está caída, el mensaje
 *     igual sale y la medición se queja en el log. Al revés —no contestarle
 *     al ciudadano porque no pudimos anotar el cobro— es cambiar un problema
 *     de plata por un problema de servicio, y el de servicio es peor.
 *
 *     La contra es real: un mensaje sin medir es plata que no se factura.
 *     Por eso el aviso es de nivel error y no un debug perdido.
 */

export interface MensajeMedido {
  /** A quién se le cobra. Si no viene, se toma del contexto de la petición. */
  organizacion?: string;
  /** Teléfono de destino en E.164: de acá sale el país y, con él, el precio. */
  destino?: string;
  contacto?: string;
  agente?: string;
  canal?: string;
  categoria?: Categoria;
  /** La cuenta del cliente bajo la que se factura este mensaje. */
  cuenta?: string;
  /** Quién lo entregó: gupshup, movitext, cloud-api. Para cuadrar su factura. */
  proveedor?: string;
  /**
   * Operador del número: el de origen y el real.
   *
   * Con portabilidad son distintos, y el que manda para el costo es el
   * FINAL. Guardar los dos es lo que deja auditar el cobro de un número
   * portado; hoy llegan vacíos porque ningún proveedor nos los reporta
   * todavía.
   */
  operadorInicial?: string;
  operadorFinal?: string;
  /** Por qué salió: respuesta del agente, seguimiento, mano del operador. */
  motivo?: 'respuesta' | 'seguimiento' | 'operador' | 'plantilla' | 'traspaso';
  /** Id del proveedor. Con él, un webhook reintentado no cobra dos veces. */
  referencia?: string;
}

export interface LineaUso {
  pais: string;
  nombrePais: string;
  categoria: Categoria;
  mensajes: number;
  micros: number;
}

export interface UsoPeriodo {
  periodo: string;
  mensajes: number;
  /** Lo que cuestan los mensajes, sin el plan. */
  micros: number;
  porPais: LineaUso[];
  porAgente: Array<{ agente: string; mensajes: number; micros: number }>;
  porMotivo: Array<{ motivo: string; mensajes: number; micros: number }>;
}

/** Sin organización no se cobra a nadie, pero queda anotado. */
const SIN_ORG = 'sin-organizacion';

@Injectable()
export class MedicionService {
  private readonly logger = new Logger(MedicionService.name);

  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    private readonly settings: SettingsService,
  ) {}

  /** El mes en curso, 'YYYY-MM'. El período de facturación es el mes natural. */
  static periodoDe(fecha = new Date()): string {
    return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** La tarifa negociada de una organización, si tiene. */
  async tarifaOrg(org: string): Promise<TarifaPorCanal | undefined> {
    return this.settings.get<TarifaPorCanal>(`tarifas:${org}`);
  }

  /**
   * NUESTRA lista de precios, la que rige cuando el cliente no negoció.
   *
   * Vive en configuración y no en código para que se pueda corregir sin
   * desplegar: una tarifa equivocada es plata por minuto.
   */
  async tarifaPlataforma(): Promise<TarifaPorCanal | undefined> {
    return this.settings.get<TarifaPorCanal>('tarifas:plataforma');
  }

  /**
   * Anota un mensaje enviado y devuelve lo que costó.
   *
   * Devuelve 0 cuando no se pudo anotar: el llamador no debe usar el valor
   * para decidir si sigue, solo para mostrarlo.
   */
  async registrar(m: MensajeMedido): Promise<number> {
    const org = m.organizacion ?? orgActual() ?? SIN_ORG;
    const pais = paisDe(m.destino);
    const categoria: Categoria = m.categoria ?? 'servicio';
    const canal = canalValido(m.canal);

    let precio = 0;
    let costo = 0;
    try {
      const [cliente, plataforma] = await Promise.all([this.tarifaOrg(org), this.tarifaPlataforma()]);
      precio = precioDe(pais.iso, categoria, { canal, cliente, plataforma });
      // Lo que nos cuesta a nosotros se guarda al lado: sin eso, el margen
      // de un mes cerrado solo se puede estimar.
      costo = costoDe(pais.iso, categoria, canal);
    } catch (err) {
      this.logger.error(`No se pudo resolver la tarifa de ${pais.iso}/${categoria}: ${(err as Error).message}`);
    }

    if (org === SIN_ORG) {
      /*
       * Un mensaje que sale sin dueño es plata que no se factura. No se
       * descarta en silencio: queda la fila con la organización vacía para
       * que aparezca en el arqueo y se pueda rastrear de dónde salió.
       */
      this.logger.error(
        `Mensaje a ${m.destino ?? 'destino desconocido'} enviado SIN organización: no se le puede facturar a nadie`,
      );
    }

    if (!this.pool) {
      // Desarrollo sin base: se ve en el log lo que habría costado.
      this.logger.log(
        `[medición] ${pais.iso}/${categoria} → cobra ${precio}, cuesta ${costo} micros (sin base, no se guarda)`,
      );
      return precio;
    }

    try {
      await ensureSchema(this.pool);
      await this.pool.query(
        `INSERT INTO consumo (id, organizacion_id, cuenta_id, periodo, agente, contacto, canal, pais,
                              prefijo, destino, proveedor, operador_inicial, operador_final,
                              categoria, motivo, cantidad, precio_micros, costo_micros, referencia)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $17, $18)
         /*
          * El predicado del índice va REPETIDO acá. El índice de referencia
          * es parcial —solo las filas que traen una— y sin repetir su
          * condición Postgres no lo reconoce: rechaza el INSERT completo con
          * «no unique constraint matching». O sea que la medición no fallaba
          * en el caso raro del reintento: no guardaba NINGÚN mensaje, y el
          * único rastro era una línea de error en el log.
          */
         ON CONFLICT (referencia) WHERE referencia IS NOT NULL DO NOTHING`,
        [
          randomUUID(),
          org,
          // Sin cuenta explícita, la principal del cliente: ningún mensaje
          // puede quedar colgando de ninguna cuenta.
          m.cuenta ?? `cta-${org}`,
          MedicionService.periodoDe(),
          m.agente ?? null,
          m.contacto ?? null,
          canal,
          pais.iso,
          pais.prefijo ?? null,
          m.destino ?? null,
          m.proveedor ?? null,
          m.operadorInicial ?? null,
          m.operadorFinal ?? null,
          categoria,
          m.motivo ?? 'respuesta',
          precio,
          costo,
          m.referencia ?? null,
        ],
      );
      return precio;
    } catch (err) {
      this.logger.error(
        `Mensaje NO medido (${pais.iso}/${categoria}, ${precio} micros): ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /** Cuántos mensajes lleva la organización en el período, y cuánto cuestan. */
  async consumo(org: string, periodo = MedicionService.periodoDe()): Promise<{ mensajes: number; micros: number }> {
    if (!this.pool) return { mensajes: 0, micros: 0 };
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT coalesce(sum(cantidad), 0)::bigint AS mensajes,
                coalesce(sum(precio_micros * cantidad), 0)::bigint AS micros
           FROM consumo WHERE organizacion_id = $1 AND periodo = $2`,
        [org, periodo],
      );
      return { mensajes: Number(r.rows[0]?.mensajes ?? 0), micros: Number(r.rows[0]?.micros ?? 0) };
    } catch (err) {
      this.logger.warn(`No se pudo leer el consumo: ${(err as Error).message}`);
      return { mensajes: 0, micros: 0 };
    }
  }

  /** El detalle del período: por país, por agente y por qué salió. */
  async detalle(org: string, periodo = MedicionService.periodoDe()): Promise<UsoPeriodo> {
    const vacio: UsoPeriodo = { periodo, mensajes: 0, micros: 0, porPais: [], porAgente: [], porMotivo: [] };
    if (!this.pool) return vacio;

    try {
      await ensureSchema(this.pool);
      const [total, pais, agente, motivo] = await Promise.all([
        this.consumo(org, periodo),
        this.pool.query(
          `SELECT pais, categoria, sum(cantidad)::int AS mensajes, sum(precio_micros * cantidad)::bigint AS micros
             FROM consumo WHERE organizacion_id = $1 AND periodo = $2
            GROUP BY pais, categoria ORDER BY micros DESC`,
          [org, periodo],
        ),
        this.pool.query(
          `SELECT coalesce(agente, 'sin agente') AS agente, sum(cantidad)::int AS mensajes,
                  sum(precio_micros * cantidad)::bigint AS micros
             FROM consumo WHERE organizacion_id = $1 AND periodo = $2
            GROUP BY 1 ORDER BY micros DESC`,
          [org, periodo],
        ),
        this.pool.query(
          `SELECT coalesce(motivo, 'respuesta') AS motivo, sum(cantidad)::int AS mensajes,
                  sum(precio_micros * cantidad)::bigint AS micros
             FROM consumo WHERE organizacion_id = $1 AND periodo = $2
            GROUP BY 1 ORDER BY micros DESC`,
          [org, periodo],
        ),
      ]);

      return {
        periodo,
        mensajes: total.mensajes,
        micros: total.micros,
        porPais: pais.rows.map((f) => ({
          pais: String(f.pais),
          nombrePais: nombrePais(String(f.pais)),
          categoria: String(f.categoria) as Categoria,
          mensajes: Number(f.mensajes),
          micros: Number(f.micros),
        })),
        porAgente: agente.rows.map((f) => ({
          agente: String(f.agente),
          mensajes: Number(f.mensajes),
          micros: Number(f.micros),
        })),
        porMotivo: motivo.rows.map((f) => ({
          motivo: String(f.motivo),
          mensajes: Number(f.mensajes),
          micros: Number(f.micros),
        })),
      };
    } catch (err) {
      this.logger.warn(`No se pudo leer el detalle de uso: ${(err as Error).message}`);
      return vacio;
    }
  }

  /**
   * Los períodos con consumo, del más nuevo al más viejo.
   *
   * No hay tabla de facturas a propósito: una factura guardada que no
   * coincide con el consumo es la peor forma de descubrir un error de
   * cobro. El mes en curso es un estimado y los cerrados se recalculan
   * siempre desde las mismas filas, con los precios que ya traen.
   */
  async periodos(org: string, limite = 12): Promise<Array<{ periodo: string; mensajes: number; micros: number }>> {
    if (!this.pool) return [];
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT periodo, sum(cantidad)::int AS mensajes, sum(precio_micros * cantidad)::bigint AS micros
           FROM consumo WHERE organizacion_id = $1
          GROUP BY periodo ORDER BY periodo DESC LIMIT $2`,
        [org, limite],
      );
      return r.rows.map((f) => ({
        periodo: String(f.periodo),
        mensajes: Number(f.mensajes),
        micros: Number(f.micros),
      }));
    } catch (err) {
      this.logger.warn(`No se pudieron leer los períodos: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Cuántos mensajes NO pedidos recibió este contacto últimamente.
   *
   * Es el freno contra el acoso, y no es el mismo que el tope de gasto: con
   * tres secuencias encendidas, cada una respetando su propio límite, una
   * persona puede recibir nueve mensajes en dos días. Eso es alguien que
   * bloquea el número — y un número bloqueado por muchos es una cuenta de
   * WhatsApp con la calidad por el piso, que es un problema del que no se
   * vuelve.
   */
  async iniciadosRecientes(org: string, contacto: string, dias = 7): Promise<number> {
    if (!this.pool) return 0;
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT coalesce(sum(cantidad), 0)::int AS n FROM consumo
          WHERE organizacion_id = $1 AND contacto = $2
            AND motivo IN ('seguimiento', 'plantilla')
            AND ocurrido > now() - ($3 || ' days')::interval`,
        [org, contacto, String(dias)],
      );
      return Number(r.rows[0]?.n ?? 0);
    } catch (err) {
      /*
       * Ante la duda, se devuelve el peor caso: así el freno actúa. Al
       * revés —cero cuando no sabemos— una base intermitente desactivaría
       * el límite justo cuando no se puede verificar nada.
       */
      this.logger.warn(`No se pudo contar los seguimientos de ${contacto}: ${(err as Error).message}`);
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /** Los últimos mensajes medidos, para que el detalle sea auditable. */
  async ultimos(org: string, limite = 50) {
    if (!this.pool) return [];
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT pais, categoria, motivo, agente, contacto, precio_micros, ocurrido
           FROM consumo WHERE organizacion_id = $1 ORDER BY ocurrido DESC LIMIT $2`,
        [org, limite],
      );
      return r.rows.map((f) => ({
        pais: String(f.pais),
        nombrePais: nombrePais(String(f.pais)),
        categoria: String(f.categoria) as Categoria,
        motivo: String(f.motivo ?? 'respuesta'),
        agente: (f.agente as string | null) ?? undefined,
        contacto: (f.contacto as string | null) ?? undefined,
        micros: Number(f.precio_micros),
        ocurrido: new Date(String(f.ocurrido)).toISOString(),
      }));
    } catch (err) {
      this.logger.warn(`No se pudieron leer los últimos mensajes: ${(err as Error).message}`);
      return [];
    }
  }
}
