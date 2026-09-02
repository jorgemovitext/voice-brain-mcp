import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/** Lo que el agente contestó en un turno. */
export interface RespuestaAgente {
  texto: string;
  /** El id que ElevenLabs le dio a ESTE turno. Se guarda para poder auditarlo. */
  conversationId?: string;
}

/**
 * Habla con un agente de ElevenLabs por WebSocket.
 *
 * UN WEBSOCKET POR TURNO, y no una conexión que viva toda la conversación.
 * No es una preferencia: cada mensaje de WhatsApp llega en su propia
 * invocación de la función serverless, que se congela al responder. Una
 * conexión persistente moriría con ella.
 *
 * Eso implica que el agente NO recuerda los turnos anteriores por su cuenta,
 * y está bien: el dueño del contexto es el Brain, no ellos. Cada turno se
 * abre mandándole el historial con `contextual_update`. Es exactamente el
 * reparto que buscábamos — su motor conversacional sobre nuestro canal y
 * nuestra memoria— y lo contrario de lo que pasaba con NL Pearl, donde el
 * hilo vivía del lado de ellos y nosotros lo espejábamos tarde.
 *
 * La autenticación va por URL firmada y no por header: el WebSocket estándar
 * de Node no admite headers propios, así que la API key se usa del lado
 * servidor para pedir una URL de un solo uso y la conexión viaja con eso.
 */
@Injectable()
export class ElevenLabsClient {
  private readonly logger = new Logger(ElevenLabsClient.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.apiUrl = config.get<string>('ELEVENLABS_API_URL', 'https://api.elevenlabs.io');
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    this.agentId = config.get<string>('ELEVENLABS_AGENT_ID', '');
    this.timeoutMs = config.get<number>('ELEVENLABS_TIMEOUT_MS', 20_000);
  }

  /** Sin key o sin agente, el motor está apagado y nadie debe llamarlo. */
  configurado(): boolean {
    return !!this.apiKey && !!this.agentId;
  }

  /** Qué falta, para poder decirlo en Actividad en vez de fallar en silencio. */
  faltantes(): string[] {
    return (['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'] as const).filter(
      (k) => !(k === 'ELEVENLABS_API_KEY' ? this.apiKey : this.agentId),
    );
  }

  /**
   * Un turno: se le pasa lo que dijo el ciudadano y el contexto del hilo, y
   * devuelve lo que contestó el agente.
   *
   * Devuelve null cuando no se pudo hablar con el agente (no configurado,
   * timeout, error de red). Nunca lanza: quien llama decide qué hacer con el
   * silencio, y un fallo del motor no puede tumbar el webhook de Gupshup.
   */
  async responder(input: {
    texto: string;
    /** Historial y datos del hilo, en texto plano. Va como contexto, no como mensaje. */
    contexto?: string;
    /** Variables que el prompt del agente puede interpolar ({{nombre}}). */
    variables?: Record<string, string>;
  }): Promise<RespuestaAgente | null> {
    if (!this.configurado()) return null;

    let url: string;
    try {
      url = await this.urlFirmada();
    } catch (err) {
      this.logger.warn(`No se pudo firmar la conexión con el agente: ${(err as Error).message}`);
      return null;
    }

    try {
      return await this.turno(url, input);
    } catch (err) {
      this.logger.warn(`El agente no contestó: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * URL de un solo uso para conectarse. La API key se queda acá, del lado
   * servidor: nunca viaja en la conexión ni sale de este proceso.
   */
  private async urlFirmada(): Promise<string> {
    const res = await firstValueFrom(
      this.http.get<{ signed_url: string }>(`${this.apiUrl}/v1/convai/conversation/get-signed-url`, {
        params: { agent_id: this.agentId },
        headers: { 'xi-api-key': this.apiKey },
        timeout: 10_000,
      }),
    );
    const firmada = res.data?.signed_url;
    if (!firmada) throw new Error('la respuesta no trajo signed_url');
    return firmada;
  }

  /** Abre, conversa un turno y cierra. */
  private turno(
    url: string,
    input: { texto: string; contexto?: string; variables?: Record<string, string> },
  ): Promise<RespuestaAgente> {
    return new Promise<RespuestaAgente>((resolve, reject) => {
      const ws = new WebSocket(url);
      let conversationId: string | undefined;
      let cerrado = false;

      const cerrar = () => {
        if (cerrado) return;
        cerrado = true;
        clearTimeout(reloj);
        try {
          ws.close();
        } catch {
          // Ya estaba cerrado: no hay nada que hacer ni que reportar.
        }
      };
      const listo = (r: RespuestaAgente) => {
        cerrar();
        resolve(r);
      };
      const fallo = (motivo: string) => {
        cerrar();
        reject(new Error(motivo));
      };

      /*
       * El reloj es lo que protege a la lambda. Sin esto, un agente que no
       * responde deja la función colgada hasta que Vercel la mata a los 30 s,
       * y el ciudadano se queda sin ninguna respuesta.
       */
      const reloj = setTimeout(() => fallo(`sin respuesta en ${this.timeoutMs} ms`), this.timeoutMs);

      ws.onopen = () => {
        // 1) Abrir la conversación, con las variables que el prompt sepa usar.
        ws.send(
          JSON.stringify({
            type: 'conversation_initiation_client_data',
            ...(input.variables && Object.keys(input.variables).length
              ? { dynamic_variables: input.variables }
              : {}),
          }),
        );

        /*
         * 2) El historial va como CONTEXTO, no como un mensaje más.
         *
         * `contextual_update` existe justamente para esto: mete información
         * sin que el agente la trate como algo que dijo el ciudadano. Si el
         * historial fuera un `user_message`, el agente contestaría al
         * historial en vez de al mensaje nuevo.
         */
        if (input.contexto) {
          ws.send(JSON.stringify({ type: 'contextual_update', text: input.contexto }));
        }

        // 3) Recién ahora, lo que la persona acaba de escribir.
        ws.send(JSON.stringify({ type: 'user_message', text: input.texto }));
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return; // Un frame que no es JSON no nos sirve; se ignora.
        }

        switch (msg['type']) {
          case 'ping': {
            // Hay que contestarlo o cierran la conexión por inactividad.
            const ping = (msg['ping_event'] ?? {}) as { event_id?: number };
            ws.send(JSON.stringify({ type: 'pong', event_id: ping.event_id }));
            return;
          }
          case 'conversation_initiation_metadata': {
            const meta = (msg['conversation_initiation_metadata_event'] ?? {}) as {
              conversation_id?: string;
            };
            conversationId = meta.conversation_id;
            return;
          }
          case 'agent_response': {
            const ev2 = (msg['agent_response_event'] ?? {}) as { agent_response?: string };
            const texto = (ev2.agent_response ?? '').trim();
            if (texto) listo({ texto, conversationId });
            return;
          }
          default:
            // El resto (audio, transcripciones, tool calls) no aplica a un
            // turno de texto: se ignora en silencio a propósito.
            return;
        }
      };

      ws.onerror = () => fallo('error de conexión con el agente');
      ws.onclose = () => {
        // Cerrar antes de contestar es un fallo, no un final normal.
        if (!cerrado) fallo('el agente cerró la conexión sin contestar');
      };
    });
  }
}
