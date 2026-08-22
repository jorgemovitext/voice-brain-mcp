import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Icon, IconName } from '../../icon';
import { VoiceNebula } from '../../nebula';
import { Worker, WorkerFlow, WorkersResponse } from '../../models';

/** Workflow propio del gateway (orquestación nuestra, no de NL Pearl). */
interface GatewayWorkflow {
  icon: IconName;
  name: string;
  trigger: string;
  steps: string[];
  link: string;
  linkLabel: string;
}

const GATEWAY_WORKFLOWS: GatewayWorkflow[] = [
  {
    icon: 'send',
    name: 'Llamada saliente con contexto',
    trigger: 'Botón de llamar / addLead',
    steps: ['addLead (NL Pearl)', 'PreCallAPI inyecta el Brain', 'Llamada', 'Webhook', 'Brain actualizado', 'WhatsApp de seguimiento'],
    link: '/contacts',
    linkLabel: 'Llamar a un contacto',
  },
  {
    icon: 'phone',
    name: 'Llamada entrante → identidad',
    trigger: 'Webhook de llamada entrante',
    steps: ['Webhook', 'Identidad por teléfono (crea contacto)', 'Contexto guardado', 'Seguimiento por WhatsApp'],
    link: '/conversations',
    linkLabel: 'Ver conversaciones',
  },
  {
    icon: 'chat',
    name: 'WhatsApp entrante → auto-respuesta',
    trigger: 'Webhook de Gupshup / Meta',
    steps: ['Mensaje entrante', 'Identidad por teléfono', 'Contexto del hilo cargado', 'Respuesta automática con contexto'],
    link: '/integrations',
    linkLabel: 'Integraciones',
  },
  {
    icon: 'database',
    name: 'Ingesta de llamada al Brain',
    trigger: 'Toda llamada finalizada',
    steps: ['getCall (transcripción, resumen, sentimiento)', 'Interacción de voz en el hilo', 'Promesa capturada → señal activa'],
    link: '/conversations',
    linkLabel: 'Ver conversaciones',
  },
];

/**
 * Obreros: los Pearls de la cuenta NL Pearl como fuerza de trabajo, con su
 * workflow (flow del Pearl vía API cuando está disponible), más los workflows
 * propios del gateway. Todo son lecturas: no gasta llamadas ni créditos.
 */
@Component({
  selector: 'app-workers',
  imports: [RouterLink, Icon, VoiceNebula],
  templateUrl: './workers.html',
  styleUrl: './workers.scss',
})
export class WorkersPage {
  private readonly api = inject(BrainApiService);

  readonly data = httpResource<WorkersResponse>(() => '/api/workers');
  /** Id de la Pearl cuya asignación se está guardando. */
  readonly assigning = signal<string | null>(null);

  readonly selectedId = signal<string | null>(null);
  readonly flow = httpResource<WorkerFlow>(() =>
    this.selectedId() ? `/api/workers/${this.selectedId()}/flow` : undefined,
  );

  readonly gatewayWorkflows = GATEWAY_WORKFLOWS;

  readonly selected = computed<Worker | null>(
    () => (this.data.value()?.workers ?? []).find((w) => w.id === this.selectedId()) ?? null,
  );

  /** Pares clave/valor del detalle, sin repetir lo ya visible en la tarjeta. */
  readonly selectedDetails = computed<Array<{ key: string; value: string }>>(() => {
    const raw = this.selected()?.raw ?? {};
    return Object.entries(raw)
      .filter(([key]) => !['id', 'name'].includes(key))
      .slice(0, 12)
      .map(([key, value]) => ({ key, value: String(value) }));
  });

  select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  statusClass(w: Worker): string {
    const s = (w.status ?? '').toLowerCase();
    if (['active', 'running', 'run', '1', 'true'].includes(s)) return 'pill--positive';
    if (['paused', 'pause', 'stopped', '0', 'false'].includes(s)) return 'pill--neutral';
    return 'pill--secondary';
  }

  statusLabel(w: Worker): string {
    const s = (w.status ?? '').toLowerCase();
    if (['active', 'running', 'run', '1', 'true'].includes(s)) return 'Activo';
    if (['paused', 'pause', 'stopped', '0', 'false'].includes(s)) return 'En pausa';
    return w.status ?? 'Estado desconocido';
  }

  /** ¿Esta Pearl es la asignada a su propio canal? */
  isAssigned(w: Worker): boolean {
    const routing = this.data.value()?.routing;
    return !!w.channel && routing?.[w.channel as 'voice' | 'whatsapp' | 'sms'] === w.id;
  }

  /**
   * Asigna o libera esta Pearl para su canal. Es el reemplazo del
   * NLPEARL_PEARL_ID del entorno: alternar es un clic, sin redeploy.
   */
  async toggleAssign(w: Worker, ev: Event): Promise<void> {
    ev.stopPropagation(); // no abrir/cerrar el detalle al asignar
    if (!w.channel) return;
    this.assigning.set(w.id);
    try {
      const canal = w.channel as 'voice' | 'whatsapp' | 'sms';
      await this.api.setPearlRouting(canal, this.isAssigned(w) ? null : w.id);
      this.data.reload();
    } finally {
      this.assigning.set(null);
    }
  }

  /** Canal legible: NL Pearl lo expone como agentType, acá se muestra en claro. */
  channelName(w: Worker): string {
    switch (w.channel) {
      case 'whatsapp':
        return 'WhatsApp';
      case 'sms':
        return 'SMS / texto';
      case 'voice':
        return 'Voz';
      default:
        return w.type ?? '';
    }
  }

  shortDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-NI', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  flowJson(flow: WorkerFlow['flow']): string {
    return JSON.stringify(flow, null, 2);
  }
}
