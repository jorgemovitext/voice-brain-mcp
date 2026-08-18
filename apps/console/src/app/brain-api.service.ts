import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DemoStatus } from './models';

/**
 * Acciones (POST) contra el backend. Las lecturas de las vistas usan
 * httpResource directamente en cada componente.
 */
@Injectable({ providedIn: 'root' })
export class BrainApiService {
  private readonly http = inject(HttpClient);

  runDemo(): Promise<{ contactId: string }> {
    return firstValueFrom(this.http.post<{ contactId: string }>('/api/demo/run', {}));
  }

  /** Práctica: llamada entrante + WhatsApp entrante del mismo número. */
  runInboundDemo(): Promise<{ phone: string }> {
    return firstValueFrom(this.http.post<{ phone: string }>('/api/demo/run-inbound', {}));
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

  /** Mensaje libre del operador (composer del chat). */
  sendMessage(contactId: string, text: string, channel?: 'whatsapp' | 'sms'): Promise<{ message: string; channel: string }> {
    return firstValueFrom(
      this.http.post<{ message: string; channel: string }>(`/api/contacts/${contactId}/messages`, { text, channel }),
    );
  }
}
