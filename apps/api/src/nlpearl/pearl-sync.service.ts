import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrainService } from '../brain/brain.service';
import { FlowLogService } from '../shared/flow-log.service';
import { NlpearlActivityStore, StoredPearl } from './activity.store';
import { NlpearlCallApiView, NlpearlClient } from './nlpearl.client';
import { toCallContext } from './nlpearl.mapper';

export interface SyncReport {
  pearls: number;
  actividades: number;
  nuevas: number;
  errores: Array<{ pearlId: string; name?: string; error: string }>;
  desde: string;
  hasta: string;
}

/** Forma parcial del Pearl en GET /v2/Pearl. // TODO: confirmar con NL Pearl */
interface PearlApiView {
  id: string;
  name?: string;
  status?: number; // 1 = activa, 2 = pausada
  type?: number; // 1 = inbound, 2 = outbound  // TODO: confirmar con NL Pearl
  [key: string]: unknown;
}

/**
 * El "espejo NL Pearl": recorre TODAS las pearls de la cuenta (voz y texto,
 * ej. "Línea 100 AMDC TEXT"), trae la actividad del rango con Calls/Bulk,
 * guarda el detalle raw en nuestra DB y alimenta el Brain con cada
 * conversación nueva (canal voice o sms según la pearl).
 *
 * Serverless: no hay timers de fondo, así que el sync se dispara por endpoint
 * (la consola lo invoca al refrescar, o manualmente / cron externo).
 */
@Injectable()
export class PearlSyncService {
  private readonly logger = new Logger(PearlSyncService.name);
  private readonly textPearlIds: Set<string>;
  /** Rate-limit por instancia: la consola sondea seguido y NL Pearl no es gratis. */
  private lastSyncAt = 0;
  private static readonly MIN_INTERVAL_MS = 30_000;

  constructor(
    private readonly client: NlpearlClient,
    private readonly store: NlpearlActivityStore,
    private readonly brain: BrainService,
    private readonly flowLog: FlowLogService,
    config: ConfigService,
  ) {
    this.textPearlIds = new Set(
      config
        .get<string>('NLPEARL_TEXT_PEARL_IDS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  /**
   * Canal del Brain para los hilos de una pearl. El API no expone un campo
   * voz/texto (verificado contra GET /v2/Pearl/{id}: mismo shape para ambas),
   * así que se decide por lista explícita (NLPEARL_TEXT_PEARL_IDS ⇒ sms) o
   * por nombre: "...Whatsapp" ⇒ whatsapp, "...TEXT/SMS/Chat" ⇒ sms.
   * // TODO: confirmar con NL Pearl si existe un campo real de canal
   */
  private canalDe(pearl: PearlApiView): StoredPearl['channel'] {
    if (this.textPearlIds.has(pearl.id)) return 'sms';
    const name = pearl.name ?? '';
    if (/whats\s?app|\bwa\b/i.test(name)) return 'whatsapp';
    if (/\b(text|sms|chat)\b/i.test(name)) return 'sms';
    return 'voice';
  }

  /** La API puede devolver el array pelado o envuelto ({results}/{data}). */
  private desenvolver<T>(res: unknown): T[] {
    if (Array.isArray(res)) return res as T[];
    const wrapped = res as { results?: T[]; data?: T[]; items?: T[] } | null;
    return wrapped?.results ?? wrapped?.data ?? wrapped?.items ?? [];
  }

  /** Sync a demanda, con rate-limit para poder colgarlo del refresh de la consola. */
  async syncIfDue(hours = 24): Promise<SyncReport | { skipped: true }> {
    if (Date.now() - this.lastSyncAt < PearlSyncService.MIN_INTERVAL_MS) return { skipped: true };
    return this.syncAll({ hours });
  }

  async syncAll(opts: { hours?: number; pearlId?: string } = {}): Promise<SyncReport> {
    this.client.assertAccountConfigured();
    this.lastSyncAt = Date.now();

    const hasta = new Date();
    const desde = new Date(hasta.getTime() - (opts.hours ?? 24) * 3600 * 1000);
    const report: SyncReport = {
      pearls: 0,
      actividades: 0,
      nuevas: 0,
      errores: [],
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
    };

    let pearls = this.desenvolver<PearlApiView>(await this.client.getPearls());
    if (opts.pearlId) pearls = pearls.filter((p) => p.id === opts.pearlId);

    for (const pearl of pearls) {
      const channel = this.canalDe(pearl);
      report.pearls++;
      await this.store.upsertPearl({
        id: pearl.id,
        name: pearl.name,
        type: pearl.type,
        status: pearl.status,
        channel,
        raw: pearl,
      });

      try {
        // El API acepta limit máximo 100 (validado contra el server real):
        // se pagina con skip hasta agotar el rango.
        const PAGE = 100;
        for (let skip = 0; ; skip += PAGE) {
          const calls = this.desenvolver<NlpearlCallApiView>(
            await this.client.getCallsBulk(pearl.id, {
              fromDate: desde.toISOString(),
              toDate: hasta.toISOString(),
              skip,
              limit: PAGE,
            }),
          );
          for (const call of calls) {
            report.actividades++;
            if (await this.ingestar(pearl, channel, call)) report.nuevas++;
          }
          if (calls.length < PAGE) break;
        }
      } catch (err) {
        // Una pearl con error (p.ej. sin permisos o sin actividad soportada)
        // no debe frenar el resto del recorrido.
        report.errores.push({ pearlId: pearl.id, name: pearl.name, error: (err as Error).message });
      }
    }

    if (report.nuevas > 0) {
      this.flowLog.push(
        'brain',
        `Sync NL Pearl: ${report.nuevas} conversación(es) nueva(s) de ${report.pearls} pearls guardadas a detalle`,
        { nuevas: report.nuevas, pearls: report.pearls },
      );
    }
    this.logger.log(
      `Sync NL Pearl: ${report.pearls} pearls, ${report.actividades} actividades (${report.nuevas} nuevas), ${report.errores.length} errores`,
    );
    return report;
  }

  /** Guarda el raw y, si es actividad nueva, la refleja en el Brain. Devuelve si era nueva. */
  private async ingestar(
    pearl: PearlApiView,
    channel: StoredPearl['channel'],
    call: NlpearlCallApiView,
  ): Promise<boolean> {
    // Dirección: si el CallApiView no la trae, se hereda del tipo de pearl
    // (inbound recibe, outbound llama). // TODO: confirmar con NL Pearl
    const conDireccion: NlpearlCallApiView = {
      ...call,
      direction: call.direction ?? (pearl.type === 2 ? 'outbound' : 'inbound'),
    };
    const ctx = toCallContext(conDireccion);

    const { inserted } = await this.store.recordActivity({
      id: call.id,
      pearlId: pearl.id,
      phone: ctx.phoneNumber,
      kind: channel === 'voice' ? 'call' : 'chat',
      occurredAt: ctx.endedAt ?? ctx.startedAt,
      raw: call,
    });
    if (!inserted) return false;
    if (!ctx.phoneNumber) return false; // sin teléfono no hay identidad que resolver

    if (channel === 'voice') {
      // Reusa el flujo de voz completo: identidad + interacción + señales (promesas).
      await this.brain.recordCallContext(ctx);
      return true;
    }

    // Texto (SMS/WhatsApp/chat): mismo hilo del contacto, con el canal de la pearl.
    const { contactId } = await this.brain.resolveIdentity({
      phone: ctx.phoneNumber,
      externalId: ctx.externalId,
      system: 'nlpearl',
    });
    await this.brain.appendInteraction({
      id: `nlpearl:${call.id}`,
      contactId,
      channel,
      direction: ctx.direction ?? 'inbound',
      occurredAt: ctx.endedAt ?? ctx.startedAt ?? new Date().toISOString(),
      summary: ctx.summary ?? this.resumenDesdeTranscript(ctx.transcript),
      transcript: ctx.transcript,
      sentiment: ctx.sentiment,
      collectedInfo: ctx.collectedInfo,
      source: 'nlpearl',
    });
    return true;
  }

  /** Un chat sin summary igual necesita algo legible en el timeline. */
  private resumenDesdeTranscript(transcript?: string): string | undefined {
    if (!transcript) return undefined;
    const primeraDelCliente = transcript
      .split('\n')
      .find((l) => l.startsWith('Cliente:'))
      ?.replace('Cliente: ', '');
    return primeraDelCliente ?? transcript.split('\n')[0];
  }
}
