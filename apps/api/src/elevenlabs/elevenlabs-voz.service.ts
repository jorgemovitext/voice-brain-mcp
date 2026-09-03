import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { BrainService } from '../brain/brain.service';
import { SettingsService } from '../shared/settings.service';

/** Un número de los que ElevenLabs tiene disponibles para llamar. */
export interface NumeroAgente {
  phone_number_id: string;
  phone_number?: string;
  label?: string;
  /** `twilio`, `exotel` o `sip_trunk`: decide por qué endpoint sale la llamada. */
  provider?: string;
}

/** Un turno de la transcripción, tal como lo entrega ElevenLabs. */
interface TurnoTranscripcion {
  role?: string;
  message?: string;
  time_in_call_secs?: number;
}

/**
 * La llamada de voz, iniciada desde nuestra app.
 *
 * Es la otra mitad del cambio de motor: hasta ahora la voz vivía en NL Pearl
 * y nosotros mirábamos desde afuera. Acá la llamada la disparamos nosotros,
 * con el contexto del Brain, y la transcripción vuelve al MISMO hilo donde
 * está lo de WhatsApp — que es de lo que se trataba orquestar canales
 * propios en vez de tener una isla por proveedor.
 */
@Injectable()
export class ElevenLabsVozService {
  private readonly logger = new Logger(ElevenLabsVozService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly phoneNumberId: string;

  constructor(
    private readonly http: HttpService,
    private readonly brain: BrainService,
    private readonly settings: SettingsService,
    config: ConfigService,
  ) {
    this.apiUrl = config.get<string>('ELEVENLABS_API_URL', 'https://api.elevenlabs.io');
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    /*
     * El agente que atiende WhatsApp lleva "Solo texto" encendido, y esa
     * opción le apaga el motor de voz: con él la llamada no levanta. Por eso
     * la voz puede apuntar a OTRO agente —mismo prompt y misma base, sin esa
     * opción—. Si no está configurado se usa el de texto: quien todavía no
     * duplicó el agente sigue como estaba, y el fallo se ve al llamar y no en
     * el arranque.
     */
    this.agentId =
      config.get<string>('ELEVENLABS_VOICE_AGENT_ID', '') ||
      config.get<string>('ELEVENLABS_AGENT_ID', '');
    this.phoneNumberId = config.get<string>('ELEVENLABS_PHONE_NUMBER_ID', '');
  }

  /** Para llamar hace falta, además del agente, un número desde el cual salir. */
  puedeLlamar(): boolean {
    return !!this.apiKey && !!this.agentId && !!this.phoneNumberId;
  }

  faltantes(): string[] {
    return [
      !this.apiKey && 'ELEVENLABS_API_KEY',
      !this.agentId && 'ELEVENLABS_AGENT_ID',
      !this.phoneNumberId && 'ELEVENLABS_PHONE_NUMBER_ID',
    ].filter(Boolean) as string[];
  }

  private get headers() {
    return { 'xi-api-key': this.apiKey };
  }

  /** Los números disponibles. Sirve para saber cuál poner en la config. */
  async numeros(): Promise<NumeroAgente[]> {
    const res = await firstValueFrom(
      this.http.get<NumeroAgente[]>(`${this.apiUrl}/v1/convai/phone-numbers`, {
        headers: this.headers,
        timeout: 10_000,
      }),
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * Llama al contacto con el agente de voz.
   *
   * El contexto del hilo viaja en la llamada: el agente atiende sabiendo lo
   * que ya se conversó por WhatsApp. Ese es el punto de tener un Brain
   * propio — con NL Pearl el contexto vivía en su plataforma y cada canal
   * arrancaba de cero.
   */
  async llamar(contactId: string, quien: string): Promise<{ ok: boolean; conversationId?: string; aviso?: string }> {
    if (!this.puedeLlamar()) {
      return { ok: false, aviso: `Falta configurar ${this.faltantes().join(', ')} para poder llamar.` };
    }

    const ctx = await this.brain.getContext({ contactId });
    const telefono = ctx.contact.phones?.[0];
    if (!telefono) return { ok: false, aviso: 'El contacto no tiene teléfono.' };

    // Twilio y SIP son endpoints distintos, y cuál toca lo dice el propio
    // número: así no hay que configurarlo aparte ni acertar de memoria.
    const ruta = (await this.esSip()) ? 'sip-trunk' : 'twilio';

    try {
      const res = await firstValueFrom(
        this.http.post<{ success?: boolean; message?: string; conversation_id?: string }>(
          `${this.apiUrl}/v1/convai/${ruta}/outbound-call`,
          {
            agent_id: this.agentId,
            agent_phone_number_id: this.phoneNumberId,
            to_number: telefono,
            conversation_initiation_client_data: {
              dynamic_variables: {
                nombre_ciudadano: ctx.contact.displayName ?? 'sin nombre registrado',
                telefono,
                // El mismo agente atiende el chat. Acá SÍ hay alguien en la
                // línea: el prompt cambia con esto y deja de dictar enlaces.
                canal: 'llamada',
              },
            },
          },
          { headers: this.headers, timeout: 15_000 },
        ),
      );

      const conversationId = res.data?.conversation_id ?? undefined;
      if (res.data?.success === false) {
        return { ok: false, aviso: res.data?.message ?? 'ElevenLabs rechazó la llamada.' };
      }

      /*
       * Se recuerda de quién es esta conversación ANTES de que empiece.
       *
       * El webhook de cierre trae el conversation_id pero no sabe nada de
       * nuestro contacto; sin este apunte, la transcripción llegaría sin
       * hilo donde ponerla. Va a la DB porque el webhook lo va a leer otra
       * instancia distinta de la que llamó.
       */
      if (conversationId) {
        await this.settings.set(`llamada:${conversationId}`, contactId);
      }

      await this.brain.appendInteraction({
        contactId,
        channel: 'voice',
        direction: 'outbound',
        occurredAt: new Date().toISOString(),
        summary: `Llamada iniciada por ${quien}`,
        source: 'own',
        handledBy: 'agente',
        accion: { tipo: 'aviso', ok: true, detalle: `Llamando a ${telefono} con el agente de voz` },
        collectedInfo: conversationId ? { conversationId } : undefined,
      });

      this.logger.log(`${quien} llamó a ${telefono} (conversación ${conversationId ?? 's/id'})`);
      return { ok: true, conversationId };
    } catch (err) {
      const aviso = this.motivo(err);
      this.logger.warn(`No se pudo llamar a ${telefono}: ${aviso}`);
      return { ok: false, aviso };
    }
  }

  /** ¿El número configurado sale por SIP? Si no se puede saber, Twilio. */
  private async esSip(): Promise<boolean> {
    try {
      const n = (await this.numeros()).find((x) => x.phone_number_id === this.phoneNumberId);
      return (n?.provider ?? '').toLowerCase().includes('sip');
    } catch {
      return false;
    }
  }

  /**
   * Trae la transcripción y la deja en el hilo, turno por turno.
   *
   * Es idempotente: cada turno se guarda con un id derivado de la
   * conversación y su posición, así que traerla dos veces —el webhook y un
   * reintento manual— no duplica el chat.
   */
  async traerTranscripcion(conversationId: string): Promise<{ nuevos: number; aviso?: string }> {
    const contactId = await this.settings.get<string>(`llamada:${conversationId}`);
    if (!contactId) {
      return { nuevos: 0, aviso: 'No sabemos de qué hilo es esa conversación.' };
    }

    try {
      const res = await firstValueFrom(
        this.http.get<{
          status?: string;
          transcript?: TurnoTranscripcion[];
          metadata?: { call_duration_secs?: number; start_time_unix_secs?: number };
          analysis?: { transcript_summary?: string };
        }>(`${this.apiUrl}/v1/convai/conversations/${conversationId}`, {
          headers: this.headers,
          timeout: 15_000,
        }),
      );

      const turnos = res.data?.transcript ?? [];
      const inicio = (res.data?.metadata?.start_time_unix_secs ?? 0) * 1000 || Date.now();
      let nuevos = 0;

      for (const [i, t] of turnos.entries()) {
        const texto = (t.message ?? '').trim();
        if (!texto) continue;
        const guardada = await this.brain.appendInteraction({
          // Determinista: reingerir la misma llamada no duplica el hilo.
          id: `eleven:${conversationId}:${i}`,
          contactId,
          channel: 'voice',
          direction: t.role === 'agent' ? 'outbound' : 'inbound',
          // Cada turno en su segundo real: el chat los ordena como ocurrieron.
          occurredAt: new Date(inicio + (t.time_in_call_secs ?? 0) * 1000).toISOString(),
          summary: texto,
          source: 'own',
          handledBy: t.role === 'agent' ? 'agente' : undefined,
        });
        if (guardada) nuevos++;
      }

      const resumen = res.data?.analysis?.transcript_summary?.trim();
      if (resumen) {
        await this.brain.appendInteraction({
          id: `eleven:${conversationId}:resumen`,
          contactId,
          channel: 'note',
          direction: 'outbound',
          occurredAt: new Date(inicio + 1).toISOString(),
          summary: resumen,
          source: 'own',
          handledBy: 'agente',
        });
      }

      this.logger.log(`Transcripción de ${conversationId}: ${turnos.length} turno(s) al hilo ${contactId}`);
      return { nuevos };
    } catch (err) {
      return { nuevos: 0, aviso: this.motivo(err) };
    }
  }

  /** El motivo que sirve para actuar, no el stack. */
  private motivo(err: unknown): string {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (e.response?.status) {
      const cuerpo = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data ?? {});
      return `ElevenLabs respondió ${e.response.status}: ${cuerpo.slice(0, 200)}`;
    }
    return e.message ?? 'error desconocido';
  }
}
