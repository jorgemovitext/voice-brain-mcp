import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NlpearlActivityStore } from './activity.store';

/**
 * Decide si un incidente cruzó el umbral E3_EXECUTIVE — el que despierta al
 * despacho del alcalde.
 *
 * Vive de nuestro lado y no en el flujo porque NL Pearl no puede contar:
 * cada conversación es independiente y el agente no ve las otras. Nosotros sí
 * tenemos todos los avances, así que acá se agrupan los reportes del MISMO
 * incidente y se mide si ya es grave.
 *
 * El guardarraíl del guion es explícito: nunca inventar urgencia. Por eso un
 * bache con 30 reportes no escala solo por volumen si el paso no está
 * obstruido, y un caso que obstruye el único acceso escala aunque haya pocos
 * reportes — lo que manda es el impacto, no el ruido.
 */
export interface Escalamiento {
  escalar: boolean;
  nivel: 'normal' | 'E3_EXECUTIVE';
  /** Cuántas personas distintas reportaron el mismo incidente. */
  reportes: number;
  minutosSinResolver: number;
  obstruyePaso: boolean;
  motivo: string;
  /** Cuerpo listo para el nodo SMS: el flujo no arma texto, solo lo pasa. */
  mensaje: string;
}

@Injectable()
export class EscalamientoService {
  private readonly logger = new Logger(EscalamientoService.name);

  /** Reportes distintos que por sí solos ya vuelven crítico el caso. */
  private readonly umbralReportes: number;
  /** Minutos sin resolver que vuelven crítico un caso que obstruye el paso. */
  private readonly umbralMinutos: number;
  /** Ventana para considerar que dos reportes son del MISMO incidente. */
  private readonly ventanaHoras: number;

  constructor(
    private readonly store: NlpearlActivityStore,
    config: ConfigService,
  ) {
    this.umbralReportes = Number(config.get('ESCALADO_REPORTES', 10));
    this.umbralMinutos = Number(config.get('ESCALADO_MINUTOS', 30));
    this.ventanaHoras = Number(config.get('ESCALADO_VENTANA_HORAS', 6));
  }

  /**
   * Normaliza una ubicación para poder agrupar por ella.
   *
   * Dos vecinos describen el mismo derrumbe como "col. Mirador del Pinar" y
   * "Colonia Mirador del Pinar, entrada"; sin normalizar contarían como
   * incidentes distintos y el umbral no se cruzaría nunca. Se comparan las
   * palabras significativas, sin tildes ni conectores.
   */
  private static tokens(ubicacion: string): Set<string> {
    const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'col', 'colonia', 'calle', 'avenida', 'av', 'barrio', 'frente', 'a', 'y']);
    return new Set(
      ubicacion
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((p) => p.length > 2 && !VACIAS.has(p)),
    );
  }

  /**
   * ¿Son el mismo incidente? Se compara por SOLAPE, no por igualdad.
   *
   * Un vecino escribe "col. Mirador del Pinar" y otro "Colonia Mirador del
   * Pinar, entrada": con igualdad exacta contarían como incidentes distintos
   * y el umbral no se cruzaría nunca. Basta con que compartan dos palabras
   * significativas — o una, cuando la descripción es de una sola palabra.
   */
  private static mismoLugar(a: Set<string>, b: Set<string>): boolean {
    if (!a.size || !b.size) return false;
    let comunes = 0;
    for (const t of a) if (b.has(t)) comunes++;
    return comunes >= Math.min(2, Math.min(a.size, b.size));
  }

  /** ¿La respuesta del flujo dice que sí? Llega como texto, no como booleano. */
  private static esSi(v: string | undefined): boolean {
    return /^(s[ií]|true|1|y|yes)$/i.test((v ?? '').trim());
  }

  async evaluar(entrada: {
    ubicacion: string;
    telefono?: string;
    obstruyePaso?: string;
    folio?: string;
  }): Promise<Escalamiento> {
    const buscado = EscalamientoService.tokens(entrada.ubicacion);
    const desde = Date.now() - this.ventanaHoras * 3600_000;

    // Todos los avances recientes: de ahí salen los reportes del incidente.
    const avances = await this.store.listActivity({ kind: 'progress', limit: 500 });

    // Por teléfono, no por avance: una misma persona empuja varios pasos del
    // flujo y contarlos todos inflaría el volumen sin que haya más gente
    // afectada — que es justo la urgencia inventada que el guion prohíbe.
    const telefonos = new Set<string>();
    let primero = Date.now();
    for (const a of avances) {
      const cuando = a.occurredAt ? Date.parse(a.occurredAt) : 0;
      if (!cuando || cuando < desde) continue;
      const datos = ((a.raw ?? {}) as { datos?: Record<string, unknown> }).datos ?? {};
      const ub = typeof datos['ubicacion'] === 'string' ? datos['ubicacion'] : '';
      if (!ub || !EscalamientoService.mismoLugar(buscado, EscalamientoService.tokens(ub))) continue;
      if (a.phone) telefonos.add(a.phone.replace(/\D/g, ''));
      primero = Math.min(primero, cuando);
    }
    // El que está reportando ahora cuenta, aunque su avance no esté guardado.
    if (entrada.telefono) telefonos.add(entrada.telefono.replace(/\D/g, ''));

    const reportes = telefonos.size;
    const minutosSinResolver = Math.max(0, Math.round((Date.now() - primero) / 60_000));
    const obstruyePaso = EscalamientoService.esSi(entrada.obstruyePaso);

    const porVolumen = reportes >= this.umbralReportes;
    const porImpacto = obstruyePaso && minutosSinResolver >= this.umbralMinutos;
    const escalar = porVolumen || porImpacto;

    const motivo = escalar
      ? [
          porVolumen ? `${reportes} reportes del mismo incidente` : null,
          porImpacto ? `el paso sigue bloqueado ${minutosSinResolver} min después del primer reporte` : null,
        ]
          .filter(Boolean)
          .join('; ')
      : `${reportes} reporte(s), sin condición crítica`;

    const folio = entrada.folio?.trim();
    const mensaje = escalar
      ? `Alerta Línea 100: incidente crítico${folio ? ` ${folio}` : ''} en ${entrada.ubicacion.trim()}. ` +
        `${motivo.charAt(0).toUpperCase()}${motivo.slice(1)}. Los equipos ya fueron notificados. ` +
        `¿Deseas un resumen ejecutivo?`
      : '';

    if (escalar) {
      this.logger.warn(`E3_EXECUTIVE en "${entrada.ubicacion}": ${motivo}`);
    }

    return {
      escalar,
      nivel: escalar ? 'E3_EXECUTIVE' : 'normal',
      reportes,
      minutosSinResolver,
      obstruyePaso,
      motivo,
      mensaje,
    };
  }
}
