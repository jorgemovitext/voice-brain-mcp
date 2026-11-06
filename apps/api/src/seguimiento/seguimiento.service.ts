import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { BrainService } from '../brain/brain.service';
import { LimitesService } from '../facturacion/limites.service';
import { MedicionService } from '../facturacion/medicion.service';
import { precioDe } from '../facturacion/tarifas';
import { ChannelPort, WHATSAPP_CHANNEL } from '../ports/channel.port';
import { conContexto, orgActual } from '../shared/contexto-org';
import { ensureSchema, PG_POOL } from '../shared/database.module';
import { SettingsService } from '../shared/settings.service';
import { PasoSeguimiento, redactar, secuencia, secuencias, SecuenciaSeguimiento } from './secuencias';

/**
 * El módulo de seguimiento: lo que el agente manda sin que le escriban.
 *
 * Cuatro frenos, y ninguno es decorativo. Los tres primeros protegen a la
 * persona que recibe; el cuarto, al cliente que paga:
 *
 *  1. Si contestó, se corta. Un seguimiento es para el silencio: seguir con
 *     la secuencia después de que alguien respondió es escribirle encima de
 *     su propia conversación.
 *  2. Nada de noche. Un WhatsApp a las 2 de la mañana no se lee: se bloquea.
 *  3. Tope por persona. Con varias secuencias encendidas, cada una
 *     respetando su propio límite, alguien puede recibir nueve mensajes en
 *     dos días.
 *  4. Tope de gasto. Una secuencia mal configurada manda miles de mensajes
 *     en una tarde y la factura la descubre el cliente a fin de mes.
 *
 * Se guarda en la base y no en memoria porque cada invocación en serverless
 * es nueva: un temporizador en proceso muere con la instancia y el
 * recordatorio de la cita no sale nunca.
 */

/** Franja en la que no se escribe. Hora local del cliente. */
const NO_MOLESTAR_DESDE = 20; // 20:00
const NO_MOLESTAR_HASTA = 7; // 07:00

/**
 * Honduras y sus vecinos: UTC-6 todo el año, sin horario de verano.
 *
 * Fijo a propósito y no tomado del servidor: en serverless el proceso corre
 * en UTC, y usar su hora mandaría los mensajes seis horas corridas — las 8
 * de la noche de allá serían las 2 de la mañana de acá.
 */
const HUSO_CENTROAMERICA = -6;

/** Cuántos mensajes no pedidos tolera una persona por semana. */
const MAX_POR_PERSONA_SEMANA = 3;

/**
 * ¿Hay que esperar a que amanezca? Devuelve cuándo, o null si se puede ya.
 *
 * No se cancela por ser de noche: se corre a la mañana. Cancelar perdería el
 * recordatorio de una cita por haber caído a las 23:40.
 *
 * Es una función aparte y no un método porque es pura —entra una hora, sale
 * otra— y así se puede probar sin levantar una base ni fingir el reloj del
 * servidor, que es justo lo que hace frágil probar horarios.
 */
export function proximaVentana(ahora: Date): Date | null {
  /*
   * La cuenta se hace ENTERA en hora local y recién al final se vuelve a
   * UTC. Mezclar las dos —mirar la hora local pero sumarle un día a la
   * fecha UTC— es el error que tenía antes: a las 22:00 de Honduras la
   * fecha UTC ya es la del día siguiente, así que sumarle un día dejaba el
   * mensaje esperando 33 horas en vez de 9. Lo encontró un test.
   */
  const desfase = HUSO_CENTROAMERICA * 3600_000;
  const local = new Date(ahora.getTime() + desfase);
  const hora = local.getUTCHours();
  if (hora >= NO_MOLESTAR_HASTA && hora < NO_MOLESTAR_DESDE) return null;

  const manana = new Date(local);
  manana.setUTCHours(NO_MOLESTAR_HASTA, 5, 0, 0);
  // Si las 07:05 de hoy ya pasaron, es la de mañana.
  if (manana.getTime() <= local.getTime()) manana.setUTCDate(manana.getUTCDate() + 1);
  return new Date(manana.getTime() - desfase);
}

/**
 * Cuándo le toca este paso, contando desde la referencia.
 *
 * Las horas negativas cuentan hacia atrás: así un recordatorio «24 h antes
 * de la cita» se calcula acá y no afuera.
 */
export function cuandoToca(referencia: Date, paso: PasoSeguimiento, ahora = new Date()): Date {
  const toca = new Date(referencia.getTime() + paso.horas * 3600_000);
  /*
   * Un paso que ya quedó en el pasado —se agendó una cita para dentro de una
   * hora y el aviso era de 24 h antes— se manda enseguida en vez de
   * perderse. Perderlo callado es el fallo que nadie reporta: la persona
   * simplemente no recibe nada.
   */
  return toca.getTime() < ahora.getTime() ? ahora : toca;
}

/** Lo que vuelve de la base puede ser Date o texto, según el driver. */
function aFecha(valor: unknown): Date {
  return valor instanceof Date ? valor : new Date(String(valor));
}

export interface ConfigSeguimiento {
  /** Qué secuencias están encendidas, por id. */
  activas: Record<string, boolean>;
  /** Tope propio de mensajes por persona y semana, si el cliente lo baja. */
  maxPorPersonaSemana?: number;
}

export interface Inscripcion {
  id: string;
  contacto: string;
  secuencia: string;
  paso: number;
  toca: string;
  estado: 'pendiente' | 'hecho' | 'cortado';
  motivoFin?: string;
}

@Injectable()
export class SeguimientoService {
  private readonly logger = new Logger(SeguimientoService.name);

  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool | null,
    private readonly brain: BrainService,
    private readonly medicion: MedicionService,
    private readonly limites: LimitesService,
    private readonly settings: SettingsService,
    private readonly organizaciones: OrganizacionesService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: ChannelPort,
  ) {}

  /* ===== Configuración ===== */

  async config(org: string): Promise<ConfigSeguimiento> {
    const guardada = await this.settings.get<ConfigSeguimiento>(`seguimiento:${org}`);
    return { activas: guardada?.activas ?? {}, maxPorPersonaSemana: guardada?.maxPorPersonaSemana };
  }

  async guardarConfig(org: string, cambios: Partial<ConfigSeguimiento>): Promise<ConfigSeguimiento> {
    const actual = await this.config(org);
    const nueva: ConfigSeguimiento = {
      activas: { ...actual.activas, ...(cambios.activas ?? {}) },
      /*
       * El tope se puede BAJAR pero no subir por encima del nuestro: un
       * cliente que pone «quince por semana» no está configurando su
       * producto, está quemando su número de WhatsApp — y la calidad de ese
       * número es un problema del que no se vuelve.
       */
      maxPorPersonaSemana:
        cambios.maxPorPersonaSemana === undefined
          ? actual.maxPorPersonaSemana
          : Math.min(MAX_POR_PERSONA_SEMANA, Math.max(1, cambios.maxPorPersonaSemana)),
    };
    await this.settings.set(`seguimiento:${org}`, nueva);
    return nueva;
  }

  /* ===== Inscripción ===== */

  /**
   * Mete a alguien en una secuencia.
   *
   * `referencia` es el momento desde el que se cuentan los pasos: la hora de
   * la cita, por ejemplo. Sin ella, ahora.
   *
   * No lanza si ya estaba: el índice único lo resuelve en silencio. Inscribir
   * dos veces es lo normal —dos mensajes seguidos de la misma persona— y
   * convertirlo en error haría fallar el webhook por algo que no es un error.
   */
  async inscribir(
    contacto: string,
    idSecuencia: string,
    opciones: { org?: string; agente?: string; referencia?: Date } = {},
  ): Promise<Inscripcion | null> {
    const org = opciones.org ?? orgActual();
    if (!org || !this.pool) return null;

    const sec = secuencia(idSecuencia);
    if (!sec?.pasos.length) return null;

    if (!(await this.limites.habilita(org, 'seguimiento'))) {
      this.logger.log(`Seguimiento no disponible en el plan de ${org}: no se inscribe a ${contacto}`);
      return null;
    }
    const config = await this.config(org);
    if (!config.activas[idSecuencia]) return null;

    const referencia = opciones.referencia ?? new Date();
    const toca = cuandoToca(referencia, sec.pasos[0]);

    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `INSERT INTO seguimientos (id, organizacion_id, contacto, agente, secuencia, paso, toca)
         VALUES ($1, $2, $3, $4, $5, 0, $6)
         ON CONFLICT DO NOTHING
         RETURNING id, contacto, secuencia, paso, toca, estado`,
        [randomUUID(), org, contacto, opciones.agente ?? null, idSecuencia, toca.toISOString()],
      );
      const f = r.rows[0];
      if (!f) return null;
      this.logger.log(`${contacto} inscrito en «${sec.nombre}» — primer mensaje ${toca.toISOString()}`);
      return {
        id: String(f.id),
        contacto: String(f.contacto),
        secuencia: String(f.secuencia),
        paso: Number(f.paso),
        toca: aFecha(f.toca).toISOString(),
        estado: 'pendiente',
      };
    } catch (err) {
      this.logger.warn(`No se pudo inscribir a ${contacto}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Inscribe en todas las secuencias AUTOMÁTICAS que el cliente encendió.
   *
   * Lo llama el webhook justo después de que el agente contestó, y es lo
   * que hace que el seguimiento ocurra sin que nadie se acuerde de
   * activarlo persona por persona.
   *
   * Que se llame en CADA respuesta y no al «cerrar» la conversación es a
   * propósito: no sabemos cuándo una conversación de WhatsApp terminó —
   * nadie la cierra, simplemente deja de escribir. Como el mensaje
   * entrante corta la inscripción anterior y la respuesta vuelve a
   * inscribir, el reloj queda contando desde la ÚLTIMA respuesta. O sea:
   * el seguimiento sale solo si la persona se quedó callada, que es
   * exactamente cuando tiene sentido.
   */
  async inscribirAutomaticas(contacto: string, agente?: string, org?: string): Promise<number> {
    const dueña = org ?? orgActual();
    if (!dueña) return 0;
    let puestas = 0;
    for (const s of secuencias()) {
      if (!s.automatica) continue;
      if (await this.inscribir(contacto, s.id, { org: dueña, agente })) puestas += 1;
    }
    return puestas;
  }

  /**
   * Saca a alguien de sus secuencias. Lo llama el webhook cuando contesta.
   *
   * Es el freno más importante del módulo: sin esto, alguien contesta el
   * primer mensaje y al día siguiente recibe el segundo como si no hubiera
   * dicho nada.
   */
  async cortar(contacto: string, motivo: string, org?: string): Promise<number> {
    const dueña = org ?? orgActual();
    if (!this.pool || !dueña) return 0;
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `UPDATE seguimientos SET estado = 'cortado', motivo_fin = $3, actualizado = now()
          WHERE organizacion_id = $1 AND contacto = $2 AND estado = 'pendiente'`,
        [dueña, contacto, motivo],
      );
      if (r.rowCount) this.logger.log(`Seguimiento cortado para ${contacto}: ${motivo}`);
      return r.rowCount ?? 0;
    } catch (err) {
      this.logger.warn(`No se pudo cortar el seguimiento de ${contacto}: ${(err as Error).message}`);
      return 0;
    }
  }

  /* ===== La corrida ===== */

  /**
   * Manda lo que toca. Lo llama el cron.
   *
   * Cada inscripción corre DENTRO de su organización: la corrida no tiene
   * sesión, y sin fijar el contexto el mensaje saldría sin dueño y sin
   * cobrar.
   */
  async correr(limite = 50): Promise<{ enviados: number; cortados: number; postergados: number }> {
    const resumen = { enviados: 0, cortados: 0, postergados: 0 };
    if (!this.pool) return resumen;

    let vencidas: Array<Record<string, unknown>> = [];
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT * FROM seguimientos WHERE estado = 'pendiente' AND toca <= now()
          ORDER BY toca ASC LIMIT $1`,
        [limite],
      );
      vencidas = r.rows;
    } catch (err) {
      this.logger.error(`No se pudo leer la cola de seguimiento: ${(err as Error).message}`);
      return resumen;
    }

    for (const fila of vencidas) {
      const org = String(fila['organizacion_id']);
      try {
        const paso = await conContexto({ org }, () => this.correrUna(fila));
        resumen[paso] += 1;
      } catch (err) {
        /*
         * Una inscripción que explota no puede frenar las demás: son de
         * clientes distintos, y el recordatorio de la cita de otro no tiene
         * por qué perderse porque este contacto no tenía teléfono.
         */
        this.logger.warn(`Seguimiento ${fila['id']} falló: ${(err as Error).message}`);
      }
    }

    if (resumen.enviados || resumen.cortados) {
      this.logger.log(
        `Seguimiento: ${resumen.enviados} enviados, ${resumen.cortados} cortados, ${resumen.postergados} postergados`,
      );
    }
    return resumen;
  }

  private async correrUna(fila: Record<string, unknown>): Promise<'enviados' | 'cortados' | 'postergados'> {
    const id = String(fila['id']);
    const org = String(fila['organizacion_id']);
    const contacto = String(fila['contacto']);
    const idSecuencia = String(fila['secuencia']);
    const indice = Number(fila['paso']);
    // `String(unDate)` da «Wed Nov 05 2026 …» y PIERDE los milisegundos: los
    // pasos siguientes quedarían corridos hasta un segundo cada vez.
    const creado = aFecha(fila['creado']);

    const sec = secuencia(idSecuencia);
    const paso = sec?.pasos[indice];
    if (!sec || !paso) {
      await this.cerrar(id, 'cortado', 'la secuencia cambió y ese paso ya no existe');
      return 'cortados';
    }

    // (1) ¿Contestó? Entonces no hay nada que seguir.
    if (await this.contestoDespuesDe(contacto, creado)) {
      await this.cerrar(id, 'cortado', 'la persona contestó');
      return 'cortados';
    }

    // (2) ¿Es de noche allá? Se corre al horario de la mañana.
    const siguiente = proximaVentana(new Date());
    if (siguiente) {
      await this.posponer(id, siguiente);
      return 'postergados';
    }

    // (3) ¿Ya recibió demasiados mensajes no pedidos?
    const config = await this.config(org);
    const tope = config.maxPorPersonaSemana ?? MAX_POR_PERSONA_SEMANA;
    if ((await this.medicion.iniciadosRecientes(org, contacto)) >= tope) {
      await this.cerrar(id, 'cortado', `ya recibió ${tope} mensajes nuestros esta semana`);
      return 'cortados';
    }

    // (4) ¿Hay presupuesto? El tope de gasto frena lo que iniciamos nosotros.
    const veredicto = await this.limites.puedeEnviar(org, { categoria: paso.categoria, motivo: 'seguimiento' });
    if (!veredicto.ok) {
      await this.cerrar(id, 'cortado', veredicto.motivo ?? 'sin presupuesto');
      return 'cortados';
    }

    const ctx = await this.brain.getContext({ contactId: contacto });
    const texto = redactar(paso.texto, {
      nombre: ctx.contact.displayName,
      negocio: await this.nombreEmpresa(org),
      agente: (fila['agente'] as string | null) ?? undefined,
    });

    await this.whatsapp.send(contacto, texto, {
      motivo: 'seguimiento',
      categoria: paso.categoria,
      agente: (fila['agente'] as string | null) ?? undefined,
    });

    await this.brain.appendInteraction({
      contactId: contacto,
      channel: 'whatsapp',
      direction: 'outbound',
      occurredAt: new Date().toISOString(),
      summary: texto,
      source: 'own',
      handledBy: 'agente',
      agente: (fila['agente'] as string | null) ?? undefined,
    });

    // ¿Queda otro paso? Si no, la secuencia terminó bien.
    const proximo = sec.pasos[indice + 1];
    if (!proximo) {
      await this.cerrar(id, 'hecho', 'la secuencia terminó');
      return 'enviados';
    }
    await this.avanzar(id, indice + 1, cuandoToca(creado, proximo));
    return 'enviados';
  }

  /* ===== Lo que ve la consola ===== */

  /**
   * Lo que costaría una secuencia, antes de encenderla.
   *
   * Está acá y no en la pantalla porque el precio depende del país y de la
   * categoría de cada paso: una cuenta hecha en el navegador con un precio
   * promedio diría un número que no es el que va a aparecer en la factura.
   */
  async estimar(
    org: string,
    sec: SecuenciaSeguimiento,
    personasPorMes = 100,
    iso = 'HN',
  ): Promise<{ mensajes: number; micros: number; porPaso: Array<{ paso: string; micros: number }> }> {
    const [cliente, plataforma] = await Promise.all([
      this.medicion.tarifaOrg(org),
      this.medicion.tarifaPlataforma(),
    ]);
    const porPaso = sec.pasos.map((p) => ({
      paso: p.id,
      // Por WhatsApp: es el único canal por el que sale un seguimiento hoy.
      micros: precioDe(iso, p.categoria, { canal: 'whatsapp', cliente, plataforma }) * personasPorMes,
    }));
    return {
      /*
       * El estimado asume el PEOR caso: que nadie contesta y todos reciben
       * todos los pasos. Es a propósito — un estimado optimista en una
       * pantalla de costos es el que genera el reclamo.
       */
      mensajes: sec.pasos.length * personasPorMes,
      micros: porPaso.reduce((t, p) => t + p.micros, 0),
      porPaso,
    };
  }

  /** Las secuencias con su estado y su costo, para la pantalla. */
  async panorama(org: string, personasPorMes = 100) {
    const [config, disponible] = await Promise.all([
      this.config(org),
      this.limites.habilita(org, 'seguimiento'),
    ]);
    const lista = await Promise.all(
      secuencias().map(async (s) => ({
        ...s,
        activa: !!config.activas[s.id],
        estimado: await this.estimar(org, s, personasPorMes),
      })),
    );
    return {
      disponible,
      maxPorPersonaSemana: config.maxPorPersonaSemana ?? MAX_POR_PERSONA_SEMANA,
      topePropio: MAX_POR_PERSONA_SEMANA,
      noMolestar: { desde: NO_MOLESTAR_DESDE, hasta: NO_MOLESTAR_HASTA },
      secuencias: lista,
      enCurso: await this.enCurso(org),
    };
  }

  /** Cuántas personas hay dentro de cada secuencia ahora mismo. */
  async enCurso(org: string): Promise<Array<{ secuencia: string; personas: number }>> {
    if (!this.pool) return [];
    try {
      await ensureSchema(this.pool);
      const r = await this.pool.query(
        `SELECT secuencia, count(*)::int AS personas FROM seguimientos
          WHERE organizacion_id = $1 AND estado = 'pendiente' GROUP BY secuencia`,
        [org],
      );
      return r.rows.map((f) => ({ secuencia: String(f.secuencia), personas: Number(f.personas) }));
    } catch {
      return [];
    }
  }

  /* ===== Internos ===== */

  private async contestoDespuesDe(contacto: string, desde: Date): Promise<boolean> {
    try {
      const ctx = await this.brain.getContext({ contactId: contacto });
      return ctx.recentInteractions.some(
        (i) => i.direction === 'inbound' && new Date(i.occurredAt).getTime() > desde.getTime(),
      );
    } catch (err) {
      /*
       * Ante la duda NO se manda: se trata como si hubiera contestado. Un
       * seguimiento de más es un mensaje cobrado y una persona molesta; uno
       * de menos no se nota.
       */
      this.logger.warn(`No se pudo revisar si ${contacto} contestó: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * El nombre del negocio, para firmar el mensaje.
   *
   * Sin nombre queda «nuestro equipo» y no un hueco: un WhatsApp que dice
   * «tu cita en {negocio}» es lo que delata que atrás no hay nadie.
   */
  private async nombreEmpresa(org: string): Promise<string> {
    const ficha = await this.organizaciones.leer(org).catch(() => null);
    return ficha?.nombre?.trim() || 'nuestro equipo';
  }

  private async cerrar(id: string, estado: 'hecho' | 'cortado', motivo: string): Promise<void> {
    await this.pool?.query(
      `UPDATE seguimientos SET estado = $2, motivo_fin = $3, actualizado = now() WHERE id = $1`,
      [id, estado, motivo],
    );
  }

  private async posponer(id: string, cuando: Date): Promise<void> {
    await this.pool?.query(`UPDATE seguimientos SET toca = $2, actualizado = now() WHERE id = $1`, [
      id,
      cuando.toISOString(),
    ]);
  }

  private async avanzar(id: string, paso: number, toca: Date): Promise<void> {
    await this.pool?.query(
      `UPDATE seguimientos SET paso = $2, toca = $3, actualizado = now() WHERE id = $1`,
      [id, paso, toca.toISOString()],
    );
  }
}
