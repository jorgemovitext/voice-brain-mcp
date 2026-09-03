import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Atencion, Contact, DemoStatus, FlowStep, NlpearlTestResult } from './models';

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
   * Manda la plantilla de saludo aprobada a un número. OJO: es un WhatsApp
   * real y consume saldo del proveedor.
   */
  probarPlantilla(to: string, nombre: string): Promise<{ ok: boolean; error?: string }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean; error?: string }>('/api/integrations/whatsapp/test', {
        to,
        nombre,
        plantilla: true,
      }),
    );
  }

  /**
   * Vuelve a proyectar los chats guardados. Es idempotente y corrige hilos
   * ingeridos con un mapeo viejo (p. ej. respuestas del agente atribuidas al
   * cliente); la API de NL Pearl no permite releerlos, así que esta es la vía.
   */
  reprocessChats(): Promise<{ conversaciones: number; mensajes: number }> {
    return firstValueFrom(
      this.http.post<{ conversaciones: number; mensajes: number }>('/api/nlpearl/reprocess', {}),
    );
  }

  /**
   * Asigna qué Pearl atiende un canal. Reemplaza al viejo NLPEARL_PEARL_ID:
   * se cambia con un clic, sin redeploy.
   */
  setPearlRouting(channel: 'voice' | 'whatsapp' | 'sms', pearlId: string | null): Promise<unknown> {
    return firstValueFrom(this.http.put('/api/workers/routing', { channel, pearlId }));
  }

  /**
   * Tomar la conversación (o devolvérsela al agente). Quién la toma lo
   * resuelve el backend desde la sesión, no se manda desde acá. Al tomarla se
   * le manda el saludo al ciudadano: `aviso` dice si eso no salió.
   */
  atenderConversacion(contactId: string, tomar: boolean): Promise<Atencion & { aviso?: string }> {
    return firstValueFrom(
      this.http.post<Atencion & { aviso?: string }>(`/api/contacts/${contactId}/atencion`, { tomar }),
    );
  }

  /** Mensaje libre del operador al ciudadano (sale por el proveedor propio). */
  enviarMensaje(contactId: string, text: string): Promise<{ message: string; channel: string }> {
    return firstValueFrom(
      this.http.post<{ message: string; channel: string }>(
        `/api/contacts/${contactId}/mensaje`,
        { text },
      ),
    );
  }

  /** Ejecuta una acción sugerida: crear el ticket, avisar a la cuadrilla. */
  /**
   * Llama al contacto con el agente de voz, de verdad.
   *
   * Distinto de `triggerCall`, que dispara la llamada simulada de la demo:
   * esta sale por el número de ElevenLabs, con el contexto del hilo, y su
   * transcripción vuelve al mismo chat cuando termina.
   */
  llamarConAgente(contactId: string): Promise<{ ok: boolean; conversationId?: string; aviso?: string }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean; conversationId?: string; aviso?: string }>(
        `/api/contacts/${contactId}/llamar`,
        {},
      ),
    );
  }

  ejecutarAccion(contactId: string, accion: string): Promise<{ id?: string; aviso?: string }> {
    return firstValueFrom(
      this.http.post<{ id?: string; aviso?: string }>(
        `/api/contacts/${contactId}/acciones/${accion}`,
        {},
      ),
    );
  }
}
