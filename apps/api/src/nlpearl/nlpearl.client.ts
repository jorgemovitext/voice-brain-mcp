import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';

/**
 * Cliente NL Pearl API v2 (https://developers.nlpearl.ai).
 *
 * Auth (confirmado en docs): header `Authorization: Bearer {AccountId}:{SecretKey}`.
 * Alternativa OAuth 2.0 disponible. // TODO: confirmar con NL Pearl si usaremos OAuth.
 *
 * Paths confirmados contra la documentación v2:
 *   POST /v2/Outbound/{pearlId}/Lead
 *   GET  /v2/Outbound/{pearlId}/Lead/External/{externalId}
 *   GET  /v2/Call/{callId}
 *   POST /v2/Pearl/{pearlId}/Calls/Bulk
 *   PUT  /v2/Pearl/{pearlId}/ResetMemory
 * Los demás siguen el mismo patrón PascalCase; los no verificados llevan
 * `// TODO: confirmar con NL Pearl`.
 */

// ---- Tipos de payload v2 (parciales, lo que consumimos) ----

export interface NlpearlLeadInput {
  phoneNumber: string; // E.164
  externalId?: string;
  timeZoneId?: string;
  /** Variables por lead para personalizar el flujo (v2 lo llama callData). */
  callData?: Record<string, string>;
}

/** Respuesta de GET /v2/Call/{callId} (CallApiView, parcial). */
export interface NlpearlCallApiView {
  id: string;
  pearlId?: string;
  startTime?: string;
  status?: number; // 4 = Completed
  conversationStatus?: number; // 100 = Success
  from?: string;
  to?: string;
  duration?: number;
  recording?: string;
  transcript?: Array<{ role: string; content: string; startTime?: number }>;
  summary?: string;
  collectedInfo?: Array<{ id: string; name: string; value: unknown }>;
  tags?: string[];
  overallSentiment?: number; // 1 (negativo) .. 5 (positivo)
  externalId?: string; // // TODO: confirmar con NL Pearl si viene en CallApiView o solo en el Lead
  /** // TODO: confirmar con NL Pearl cómo distingue inbound/outbound el CallApiView */
  direction?: 'inbound' | 'outbound';
}

export interface GetCallsBulkInput {
  fromDate: string; // ISO 8601
  toDate: string; // ISO 8601
  /** "Transcript" | "CollectedInfo" | "Summary" | "OverallSentiment" | "Recording" ... */
  fields?: string[];
  skip?: number;
  limit?: number;
  tags?: string[];
  statuses?: number[];
}

@Injectable()
export class NlpearlClient {
  private readonly logger = new Logger(NlpearlClient.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly accountId: string;
  private readonly apiKey: string;
  readonly pearlId: string;

  private static readonly TIMEOUT_MS = 15_000;
  private static readonly MAX_RETRIES = 2;

  constructor(private readonly http: HttpService, config: ConfigService) {
    // Los paths de abajo ya incluyen /v2, así que se tolera que la base venga
    // como `https://api.nlpearl.ai` o como `https://api.nlpearl.ai/v2`.
    this.baseUrl = config
      .get<string>('NLPEARL_BASE_URL', 'https://api.nlpearl.ai')
      .replace(/\/+$/, '')
      .replace(/\/v2$/i, '');
    this.accountId = config.get<string>('NLPEARL_ACCOUNT_ID', '');
    this.apiKey = config.get<string>('NLPEARL_API_KEY', '');
    // Formato Bearer confirmado en docs: "AccountId:SecretKey"
    this.authHeader = `Bearer ${this.accountId}:${this.apiKey}`;
    this.pearlId = config.get<string>('NLPEARL_PEARL_ID', '');
  }

  /**
   * Con MOCK=false hace falta la configuración real. Sin ella, cualquier
   * llamada saldría con `Authorization: Bearer :` y el error de NL Pearl no
   * diría qué falta; mejor fallar acá con un mensaje accionable.
   */
  assertConfigured(): void {
    const faltantes = [
      ['NLPEARL_ACCOUNT_ID', this.accountId],
      ['NLPEARL_API_KEY', this.apiKey],
      ['NLPEARL_PEARL_ID', this.pearlId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (faltantes.length) {
      throw new ServiceUnavailableException(
        `Faltan credenciales de NL Pearl: ${faltantes.join(', ')}. ` +
          'Cargalas como variables de entorno, o poné MOCK=true para el modo simulado.',
      );
    }
  }

  // =============== Disparo y leads (Outbound) ===============

  /** Dispara la llamada saliente en v2 (no existe "Make Call"; era de v1 legacy). */
  addLead(pearlId: string, lead: NlpearlLeadInput): Promise<{ id: string }> {
    return this.request('POST', `/v2/Outbound/${pearlId}/Lead`, lead);
  }

  /** Alta masiva de leads. // TODO: confirmar con NL Pearl el path exacto (Leads vs Lead/Bulk) */
  addLeads(pearlId: string, leads: NlpearlLeadInput[]): Promise<unknown> {
    return this.request('POST', `/v2/Outbound/${pearlId}/Leads`, { leads });
  }

  /** // TODO: confirmar con NL Pearl (método PATCH/PUT y shape) */
  updateLead(pearlId: string, leadId: string, patch: Partial<NlpearlLeadInput>): Promise<unknown> {
    return this.request('PATCH', `/v2/Outbound/${pearlId}/Lead/${leadId}`, patch);
  }

  getLead(pearlId: string, leadId: string): Promise<unknown> {
    return this.request('GET', `/v2/Outbound/${pearlId}/Lead/${leadId}`);
  }

  /** Path confirmado en docs v2. */
  getLeadByExternalId(pearlId: string, externalId: string): Promise<unknown> {
    return this.request('GET', `/v2/Outbound/${pearlId}/Lead/External/${encodeURIComponent(externalId)}`);
  }

  /** // TODO: confirmar con NL Pearl el segmento exacto (Phone vs PhoneNumber) */
  getLeadByPhone(pearlId: string, phone: string): Promise<unknown> {
    return this.request('GET', `/v2/Outbound/${pearlId}/Lead/Phone/${encodeURIComponent(phone)}`);
  }

  /** // TODO: confirmar con NL Pearl (POST con paginación) */
  searchLeads(pearlId: string, query: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/v2/Outbound/${pearlId}/Leads/Search`, query);
  }

  // =============== Contexto de llamadas (Call / Pearl) ===============

  /** Detalle de una llamada (path confirmado). */
  getCall(callId: string): Promise<NlpearlCallApiView> {
    return this.request('GET', `/v2/Call/${callId}`);
  }

  /**
   * Endpoint clave para alimentar el Brain: llamadas en rango con fields
   * selectivos (Transcript, CollectedInfo, Summary, OverallSentiment, Recording).
   * Path confirmado: POST /v2/Pearl/{pearlId}/Calls/Bulk
   */
  getCallsBulk(pearlId: string, input: GetCallsBulkInput): Promise<NlpearlCallApiView[]> {
    return this.request('POST', `/v2/Pearl/${pearlId}/Calls/Bulk`, {
      fields: ['Transcript', 'CollectedInfo', 'Summary', 'OverallSentiment', 'Recording'],
      ...input,
    });
  }

  /** // TODO: confirmar con NL Pearl (shape del body de rango) */
  getCalls(pearlId: string, range: { fromDate: string; toDate: string }): Promise<unknown> {
    return this.request('POST', `/v2/Pearl/${pearlId}/Calls`, range);
  }

  /** // TODO: confirmar con NL Pearl */
  getOngoingCalls(pearlId: string): Promise<unknown> {
    return this.request('GET', `/v2/Pearl/${pearlId}/Calls/Ongoing`);
  }

  /** // TODO: confirmar con NL Pearl (puede devolver URL o binario) */
  getRecording(callId: string): Promise<unknown> {
    return this.request('GET', `/v2/Call/${callId}/Recording`);
  }

  // =============== Configuración (Pearl / Pearl Flow / Settings) ===============

  getPearls(): Promise<unknown> {
    return this.request('GET', `/v2/Pearl`);
  }

  getPearl(pearlId: string): Promise<unknown> {
    return this.request('GET', `/v2/Pearl/${pearlId}`);
  }

  /** run | pause. // TODO: confirmar con NL Pearl el valor del body */
  setActivityState(pearlId: string, state: 'run' | 'pause'): Promise<unknown> {
    return this.request('PUT', `/v2/Pearl/${pearlId}/ActivityState`, { state });
  }

  /**
   * Crea el Pearl de voz con el grafo del flujo. El grafo debe incluir un
   * nodo PreCallAPI apuntando a nuestro POST /precall, OpeningSentence y EndCall.
   * // TODO: confirmar con NL Pearl el path (PearlFlow) y el schema del grafo
   */
  createVoicePearl(graph: unknown): Promise<unknown> {
    return this.request('POST', `/v2/PearlFlow/VoicePearl`, graph);
  }

  /** // TODO: confirmar con NL Pearl */
  updateVoicePearl(pearlId: string, graph: unknown): Promise<unknown> {
    return this.request('PATCH', `/v2/PearlFlow/VoicePearl/${pearlId}`, graph);
  }

  /** // TODO: confirmar con NL Pearl */
  getPearlSettings(pearlId: string): Promise<unknown> {
    return this.request('GET', `/v2/PearlFlow/${pearlId}`);
  }

  /**
   * Aquí se registra nuestro webhook de llamada finalizada
   * (POST {nuestra_url}/webhooks/nlpearl). // TODO: confirmar con NL Pearl el campo exacto
   */
  updateOutboundSettings(pearlId: string, settings: { webhookUrl?: string } & Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/v2/PearlFlow/${pearlId}/Outbound`, settings);
  }

  /** // TODO: confirmar con NL Pearl */
  updateInboundSettings(pearlId: string, settings: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/v2/PearlFlow/${pearlId}/Inbound`, settings);
  }

  /** Credenciales para acciones API dentro del flujo (p. ej. KYCM). // TODO: confirmar path */
  getPearlCredentials(pearlId: string): Promise<unknown> {
    return this.request('GET', `/v2/PearlFlow/${pearlId}/Credentials`);
  }

  /** // TODO: confirmar con NL Pearl */
  getVoices(): Promise<unknown> {
    return this.request('GET', `/v2/PearlSettings/Voices`);
  }

  /** // TODO: confirmar con NL Pearl */
  getPhoneNumbers(): Promise<unknown> {
    return this.request('GET', `/v2/PearlSettings/Phones`);
  }

  /**
   * GET suelto para diagnóstico: la doc pública no fija el path de varios
   * recursos, así que se prueban candidatos y se reporta cuál responde.
   * No lanza: devuelve el status para poder comparar.
   */
  async probe(path: string): Promise<{ path: string; status: number; data: unknown }> {
    try {
      const res = await firstValueFrom(
        this.http.request({
          method: 'GET',
          url: `${this.baseUrl}${path}`,
          timeout: 10_000,
          headers: { Authorization: this.authHeader },
          validateStatus: () => true,
        }),
      );
      return { path, status: res.status, data: res.data };
    } catch (err) {
      return { path, status: 0, data: (err as Error).message };
    }
  }

  // =============== Cumplimiento (Account) ===============

  /** // TODO: confirmar con NL Pearl (GET vs POST con filtros) */
  searchBlacklist(): Promise<unknown> {
    return this.request('GET', `/v2/Account/Blacklist`);
  }

  addToBlacklist(numbers: string[]): Promise<unknown> {
    return this.request('POST', `/v2/Account/Blacklist/Add`, { phoneNumbers: numbers });
  }

  removeFromBlacklist(numbers: string[]): Promise<unknown> {
    return this.request('POST', `/v2/Account/Blacklist/Remove`, { phoneNumbers: numbers });
  }

  /** // TODO: confirmar con NL Pearl */
  getAuditLog(): Promise<unknown> {
    return this.request('GET', `/v2/Account/AuditLog`);
  }

  getAccount(): Promise<unknown> {
    return this.request('GET', `/v2/Account`);
  }

  /** // TODO: confirmar con NL Pearl */
  getAccountUsers(): Promise<unknown> {
    return this.request('GET', `/v2/Account/Users`);
  }

  /** Limpia la memoria de voz de un contacto (path confirmado). */
  resetCustomerMemory(pearlId: string, phoneNumber: string): Promise<unknown> {
    return this.request('PUT', `/v2/Pearl/${pearlId}/ResetMemory`, { phoneNumber });
  }

  // =============== Infraestructura HTTP ===============

  /** Request con timeout y reintento simple (2 reintentos con backoff). */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url: `${this.baseUrl}${path}`,
      data: body,
      timeout: NlpearlClient.TIMEOUT_MS,
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= NlpearlClient.MAX_RETRIES; attempt++) {
      try {
        const res = await firstValueFrom(this.http.request<T>(config));
        return res.data;
      } catch (err) {
        lastError = err;
        const status = (err as { response?: { status?: number } }).response?.status;
        // No reintentar errores de cliente (4xx): son definitivos.
        if (status && status >= 400 && status < 500) break;
        this.logger.warn(`NL Pearl ${method} ${path} falló (intento ${attempt + 1}): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw new Error(`NL Pearl ${method} ${path}: ${(lastError as Error)?.message ?? 'error desconocido'}`);
  }
}
