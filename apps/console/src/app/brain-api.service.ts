import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Contact, DemoStatus, FlowStep, NlpearlTestResult } from './models';

/**
 * Acciones (POST) contra el backend. Las lecturas de las vistas usan
 * httpResource directamente en cada componente.
 */
@Injectable({ providedIn: 'root' })
export class BrainApiService {
  private readonly http = inject(HttpClient);

  /**
   * Ambas demos devuelven `steps` cuando el backend completó el flujo dentro
   * del request (serverless); si viene vacío, el flujo corre detrás y hay que
   * seguirlo con demoStatus().
   */
  runDemo(): Promise<{ contactId: string; steps: FlowStep[] }> {
    return firstValueFrom(this.http.post<{ contactId: string; steps: FlowStep[] }>('/api/demo/run', {}));
  }

  /** Práctica: llamada entrante + WhatsApp entrante del mismo número. */
  runInboundDemo(): Promise<{ phone: string; steps: FlowStep[] }> {
    return firstValueFrom(this.http.post<{ phone: string; steps: FlowStep[] }>('/api/demo/run-inbound', {}));
  }

  demoStatus(): Promise<DemoStatus> {
    return firstValueFrom(this.http.get<DemoStatus>('/api/demo/status'));
  }

  triggerCall(contactId: string): Promise<{ leadId: string }> {
    return firstValueFrom(this.http.post<{ leadId: string }>('/api/calls/trigger', { contactId }));
  }

  sendFollowup(contactId: string, channel?: 'whatsapp' | 'sms'): Promise<{ message: string; channel: string }> {
    return firstValueFrom(
      this.http.post<{ message: string; channel: string }>(`/api/contacts/${contactId}/followup`, { channel }),
    );
  }

  /** Verifica que NL Pearl responda (lectura, no gasta llamadas). */
  testNlpearl(): Promise<NlpearlTestResult> {
    return firstValueFrom(this.http.post<NlpearlTestResult>('/api/integrations/nlpearl/test', {}));
  }

  /** Da de alta un número (E.164) para empezar a conversar con él. */
  createContact(phone: string, displayName?: string): Promise<{ contact: Contact; created: boolean }> {
    return firstValueFrom(
      this.http.post<{ contact: Contact; created: boolean }>('/api/contacts', { phone, displayName }),
    );
  }

  /** Mensaje libre del operador (composer del chat). */
  sendMessage(contactId: string, text: string, channel?: 'whatsapp' | 'sms'): Promise<{ message: string; channel: string }> {
    return firstValueFrom(
      this.http.post<{ message: string; channel: string }>(`/api/contacts/${contactId}/messages`, { text, channel }),
    );
  }
}
