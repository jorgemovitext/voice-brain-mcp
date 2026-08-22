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

  /**
   * Nota interna del operador (composer del chat). Queda en el hilo para el
   * equipo; NO viaja al cliente — los agentes conversan por sus canales.
   */
  addNote(contactId: string, text: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/contacts/${contactId}/notes`, { text }));
  }

  /**
   * Espejo NL Pearl: trae la actividad nueva de TODAS las pearls (voz y
   * texto). `soft` respeta el rate-limit del backend (~30 s), pensado para
   * colgarlo del refresco automático de las vistas.
   */
  syncNlpearl(soft = true): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/nlpearl/sync?soft=${soft}`, {}));
  }

  /**
   * Asigna qué Pearl atiende un canal. Reemplaza al viejo NLPEARL_PEARL_ID:
   * se cambia con un clic, sin redeploy.
   */
  setPearlRouting(channel: 'voice' | 'whatsapp' | 'sms', pearlId: string | null): Promise<unknown> {
    return firstValueFrom(this.http.put('/api/workers/routing', { channel, pearlId }));
  }
}
