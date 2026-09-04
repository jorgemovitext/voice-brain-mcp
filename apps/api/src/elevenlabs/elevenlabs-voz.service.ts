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
  supports_outbound?: boolean;
  assigned_agent?: { agent_id?: string; agent_name?: string };
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

  /**
   * El número desde el cual sale la llamada, resuelto contra el proveedor.
   *
   * NO se usa el id de la variable de entorno a ciegas: los números se borran
   * y se vuelven a crear con otro id, y entonces llamar daba
   * "Document with id phnum_… not found" sin que nada más cambiara. Se prefiere
   * el configurado si todavía existe, y si no, el que esté asignado a nuestro
   * agente y sirva para salir.
   */
  private async numeroDeSalida(): Promise<NumeroAgente | undefined> {
    const todos = await this.numeros().catch(() => [] as NumeroAgente[]);
    if (!todos.length) return undefined;

    const configurado = todos.find((n) => n.phone_number_id === this.phoneNumberId);
    if (configurado) return configurado;

    if (this.phoneNumberId) {
      this.logger.warn(
        `ELEVENLABS_PHONE_NUMBER_ID apunta a un número que ya no existe; se usa el del agente.`,
      );
    }
    const delAgente = todos.find((n) => n.assigned_agent?.agent_id === this.agentId && n.supports_outbound);
    return delAgente ?? todos.find((n) => n.supports_outbound);
  }

  /** Para llamar hace falta, además del agente, un número desde el cual salir. */
  puedeLlamar(): boolean {
    // El número ya no se exige acá: se resuelve al llamar, así que la cuenta
    // puede tener uno aunque la variable de entorno esté vieja o vacía.
    return !!this.apiKey && !!this.agentId;
  }

  faltantes(): string[] {
    return [!this.apiKey && 'ELEVENLABS_API_KEY', !this.agentId && 'ELEVENLABS_AGENT_ID'].filter(
      Boolean,
    ) as string[];
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

    const numero = await this.numeroDeSalida();
    if (!numero) {
      return { ok: false, aviso: 'La cuenta no tiene ningún número para llamar. Agregá uno en el proveedor.' };
    }

    // Twilio, Exotel y SIP son endpoints distintos, y cuál toca lo dice el
    // propio número: así no hay que configurarlo aparte ni acertar de memoria.
    const ruta = ElevenLabsVozService.rutaDe(numero.provider);

    try {
      const res = await firstValueFrom(
        this.http.post<{ success?: boolean; message?: string; conversation_id?: string }>(
          `${this.apiUrl}/v1/convai/${ruta}/outbound-call`,
          {
            agent_id: this.agentId,
            agent_phone_number_id: numero.phone_number_id,
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

  /**
   * Por qué endpoint sale la llamada, según quién provee el número.
   *
   * Cada proveedor tiene el suyo y no son intercambiables: mandar un número de
   * Exotel por la ruta de Twilio da error. Antes esto era un booleano
   * "¿es SIP?" que caía a Twilio para todo lo demás — y el número real de la
   * cuenta resultó ser de Exotel, así que la llamada nunca habría salido.
   */
  private static rutaDe(provider?: string): string {
    const p = (provider ?? '').toLowerCase();
    if (p.includes('sip')) return 'sip-trunk';
    if (p.includes('exotel')) return 'exotel';
    // Twilio es el más común, y si no era, el error de ElevenLabs lo dice.
    return 'twilio';
  }

  /**
   * Trae la transcripción y la deja en el hilo, turno por turno.
   *
   * Es idempotente: cada turno se guarda con un id derivado de la
   * conversación y su posición, así que traerla dos veces —el webhook y un
   * reintento manual— no duplica el chat.
   */
  async traerTranscripcion(conversationId: string): Promise<{ nuevos: number; aviso?: string }> {
    try {
      const res = await firstValueFrom(
        this.http.get<{
          status?: string;
          transcript?: TurnoTranscripcion[];
          metadata?: {
            call_duration_secs?: number;
            start_time_unix_secs?: number;
            phone_call?: { direction?: string; external_number?: string };
          };
          analysis?: { transcript_summary?: string };
        }>(`${this.apiUrl}/v1/convai/conversations/${conversationId}`, {
          headers: this.headers,
          timeout: 15_000,
        }),
      );

      /*
       * De qué hilo es esta llamada.
       *
       * Si la iniciamos nosotros hay un mapeo guardado. Si no —una llamada
       * entrante, o una saliente hecha desde el panel del proveedor— se resuelve
       * por el número del otro lado, que viene en la metadata.
       *
       * Antes se cortaba acá con "no sabemos de qué hilo es", así que TODA
       * llamada que no saliera de nuestro botón se descartaba: no aparecía en
       * Conversaciones ni contaba en el tablero, aunque hubiera ocurrido.
       */
      const telefono = res.data?.metadata?.phone_call?.external_number;
      let contactId = await this.settings.get<string>(`llamada:${conversationId}`);
      if (!contactId && telefono) {
        const { contactId: id } = await this.brain.resolveIdentity({
          // Llega sin "+": es un teléfono real y el Brain normaliza a E.164.
          phone: telefono.startsWith('+') ? telefono : `+${telefono}`,
        });
        contactId = id;
        // Para que los webhooks siguientes de esta misma llamada no lo rebusquen.
        await this.settings.set(`llamada:${conversationId}`, contactId);
        this.logger.log(`Llamada ${conversationId} vinculada por número a ${contactId}`);
      }
      if (!contactId) {
        return { nuevos: 0, aviso: 'La llamada no trae número ni hilo conocido.' };
      }

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
    if (!e.response?.status) return e.message ?? 'error desconocido';

    const cuerpo = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data ?? {});

    /*
     * Un 424 no es un fallo de ElevenLabs: es la telefonía de abajo que
     * rechazó la llamada, y el volcado crudo del error no le dice a nadie qué
     * hacer. Quien lo lee está en la consola queriendo llamar a un vecino, no
     * depurando una integración.
     */
    if (e.response.status === 424 || /upstream_service_error/.test(cuerpo)) {
      const quien = /exotel/i.test(cuerpo) ? 'Exotel' : /twilio/i.test(cuerpo) ? 'Twilio' : 'la telefonía';
      return (
        `${quien} rechazó la llamada. Suele ser el número de destino: en cuentas ` +
        `nuevas solo se puede llamar a números verificados, y el formato tiene que ` +
        `ser internacional (+504…). Revisá eso en el panel de ${quien}.`
      );
    }

    return `ElevenLabs respondió ${e.response.status}: ${cuerpo.slice(0, 200)}`;
  }
}
