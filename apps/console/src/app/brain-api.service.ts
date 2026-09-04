import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AristaFlujo, Atencion, Contact, DemoStatus, FlowStep, NlpearlTestResult, NodoFlujo } from './models';

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

  /* --- Módulo de Agentes --- */

  crearAgente(nombre: string): Promise<{ id: string }> {
    return firstValueFrom(
      this.http.post<{ id: string }>('/api/agentes', {
        nombre,
        // Un punto de partida, no una plantilla: se edita enseguida en el editor.
        instrucciones: 'Sos un asistente. Contestá corto, claro y en español.',
      }),
    );
  }

  actualizarAgente(
    id: string,
    cambios: {
      instrucciones?: string;
      primerMensaje?: string;
      soloTexto?: boolean;
      herramientas?: string[];
    },
  ): Promise<{ ok: boolean }> {
    return firstValueFrom(this.http.patch<{ ok: boolean }>(`/api/agentes/${id}`, cambios));
  }

  duplicarAgente(id: string, nombre: string): Promise<{ id: string }> {
    return firstValueFrom(this.http.post<{ id: string }>(`/api/agentes/${id}/duplicar`, { nombre }));
  }

  eliminarAgente(id: string): Promise<{ ok: boolean }> {
    return firstValueFrom(this.http.delete<{ ok: boolean }>(`/api/agentes/${id}`));
  }

  agregarContextoAgente(id: string, titulo: string, texto: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(`/api/agentes/${id}/contexto`, { titulo, texto }),
    );
  }

  /** Banco de pruebas: las herramientas se simulan, no se ejecutan. */
  probarAgente(
    id: string,
    texto: string,
    historial: Array<{ de: 'persona' | 'agente'; texto: string }>,
  ): Promise<{
    respuesta: string | null;
    herramientas: Array<{ nombre: string; args: Record<string, unknown> }>;
  }> {
    return firstValueFrom(
      this.http.post<{
        respuesta: string | null;
        herramientas: Array<{ nombre: string; args: Record<string, unknown> }>;
      }>(`/api/agentes/${id}/probar`, { texto, historial }),
    );
  }

  guardarFlujoAgente(
    id: string,
    flujo: { nodos: NodoFlujo[]; aristas: AristaFlujo[] },
  ): Promise<{ ok: boolean }> {
    return firstValueFrom(this.http.patch<{ ok: boolean }>(`/api/agentes/${id}/flujo`, flujo));
  }

  /** Abre un ticket y una tarea reales en HubSpot y borra el ticket. */
  probarEscrituraCrm(): Promise<{
    configurado: boolean;
    motivo?: string;
    pasos: Array<{ paso: string; ok: boolean; detalle: string }>;
  }> {
    return firstValueFrom(
      this.http.post<{
        configurado: boolean;
        motivo?: string;
        pasos: Array<{ paso: string; ok: boolean; detalle: string }>;
      }>('/api/hubspot/probar-escritura', {}),
    );
  }

  /** Reingesta TODAS las llamadas del agente. Idempotente. */
  reprocesarLlamadas(): Promise<{
    revisadas: number;
    llamadas: number;
    nuevos: number;
    hilos: number;
    deTexto: number;
    avisos: string[];
  }> {
    return firstValueFrom(
      this.http.post<{
        revisadas: number;
        llamadas: number;
        nuevos: number;
        hilos: number;
        deTexto: number;
        avisos: string[];
      }>('/api/voz/reprocesar', {}),
    );
  }

  /**
   * Un turno del asistente que arma agentes.
   *
   * `agenteId` viaja en los dos sentidos porque el agente se crea a mitad de
   * la charla: el servidor lo devuelve al crearlo y la consola lo manda de
   * vuelta para que los turnos siguientes hablen del mismo.
   */
  asistenteDeAgentes(
    turnos: Array<{ de: 'persona' | 'asistente'; texto: string }>,
    agenteId: string | null,
  ): Promise<{
    respuesta: string;
    agenteId: string | null;
    cambios: Array<{ accion: string; detalle: string }>;
  }> {
    return firstValueFrom(
      this.http.post<{
        respuesta: string;
        agenteId: string | null;
        cambios: Array<{ accion: string; detalle: string }>;
      }>('/api/agentes/asistente', { turnos, agenteId }),
    );
  }

  /**
   * Le pide al servidor que revise si falta alguna llamada.
   *
   * Se cuelga del sondeo de la bandeja. El freno es del servidor —una revisión
   * cada cuarto de hora como mucho—, así que pedirlo en cada vuelta no le
   * cuesta nada al proveedor.
   */
  reconciliarLlamadas(): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/voz/reconciliar', {}));
  }
}
