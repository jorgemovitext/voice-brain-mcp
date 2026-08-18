import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrainApiService } from '../../brain-api.service';
import { Icon, IconName } from '../../icon';
import { FlowStep } from '../../models';

interface StepDef {
  key: string;
  label: string;
  icon: IconName;
}

type Scenario = 'outbound' | 'inbound';

/** Escenario 1 — flujo saliente completo. */
const OUTBOUND_STEPS: StepDef[] = [
  { key: 'seed', label: 'Sembrado: contacto con promesa activa e historial de WhatsApp', icon: 'sprout' },
  { key: 'addLead', label: 'addLead (NL Pearl v2): llamada saliente disparada', icon: 'send' },
  { key: 'precall', label: 'PreCallAPI: contexto del Brain inyectado al agente', icon: 'chip' },
  { key: 'webhook', label: 'Webhook: llamada finalizada', icon: 'inbox' },
  { key: 'brain', label: 'Brain actualizado: transcripción, resumen, sentimiento y promesa', icon: 'database' },
  { key: 'followup', label: 'WhatsApp de seguimiento con el contexto actualizado', icon: 'chat' },
];

/** Escenario 2 — práctica entrante: llamada que entra + WhatsApp del mismo número. */
const INBOUND_STEPS: StepDef[] = [
  { key: 'inboundCall', label: 'Llamada ENTRANTE de un número (sin contacto previo)', icon: 'phone' },
  { key: 'webhook', label: 'Webhook: llamada finalizada', icon: 'inbox' },
  { key: 'brain', label: 'Brain: contacto creado por teléfono + contexto de la llamada guardado', icon: 'database' },
  { key: 'followup', label: 'WhatsApp de seguimiento enviado tras la llamada', icon: 'chat' },
  { key: 'inboundMsg', label: 'WhatsApp ENTRANTE del mismo número', icon: 'mail' },
  { key: 'contextHit', label: 'Identidad reconocida: mismo contactId, contexto del hilo cargado', icon: 'users' },
  { key: 'autoReply', label: 'Respuesta automática usando el contexto de la llamada', icon: 'send' },
];

/** Última clave esperada por escenario (cierra el stepper). */
const FINAL_KEY: Record<Scenario, string> = { outbound: 'followup', inbound: 'autoReply' };

/**
 * Vista Demo: dos escenarios end-to-end en mock, con paso a paso en vivo
 * (polling a /api/demo/status).
 */
@Component({
  selector: 'app-demo',
  imports: [RouterLink, Icon],
  templateUrl: './demo.html',
  styleUrl: './demo.scss',
})
export class DemoPage implements OnDestroy {
  private readonly api = inject(BrainApiService);
  private pollTimer?: ReturnType<typeof setInterval>;

  readonly scenario = signal<Scenario>('outbound');
  readonly running = signal(false);
  readonly started = signal(false);
  readonly error = signal<string | null>(null);
  readonly steps = signal<FlowStep[]>([]);
  readonly contactId = signal<string | null>(null);

  readonly stepDefs = computed<StepDef[]>(() =>
    this.scenario() === 'inbound' ? INBOUND_STEPS : OUTBOUND_STEPS,
  );

  readonly doneKeys = computed(() => new Set(this.steps().map((s) => s.step)));
  readonly finished = computed(
    () => this.started() && !this.running() && this.doneKeys().has(FINAL_KEY[this.scenario()]),
  );

  async run(scenario: Scenario): Promise<void> {
    this.scenario.set(scenario);
    this.error.set(null);
    this.steps.set([]);
    this.contactId.set(null);
    this.started.set(true);
    this.running.set(true);
    try {
      if (scenario === 'outbound') {
        const { contactId } = await this.api.runDemo();
        this.contactId.set(contactId);
      } else {
        await this.api.runInboundDemo();
      }
      this.poll();
    } catch {
      this.error.set('No se pudo iniciar el flujo. ¿Está corriendo la API en el puerto 3000?');
      this.running.set(false);
    }
  }

  private poll(): void {
    clearInterval(this.pollTimer);
    const finalKey = FINAL_KEY[this.scenario()];
    let ticks = 0;
    this.pollTimer = setInterval(async () => {
      try {
        const status = await this.api.demoStatus();
        this.steps.set(status.steps);

        // En la práctica entrante el contactId viene en el paso contextHit.
        const hit = status.steps.find((s) => s.step === 'contextHit');
        const hitId = (hit?.detail as { contactId?: string } | undefined)?.contactId;
        if (hitId) this.contactId.set(hitId);

        const done = status.steps.some((s) => s.step === finalKey || s.step === 'error');
        if (done || ++ticks > 80) {
          this.running.set(false);
          clearInterval(this.pollTimer);
        }
      } catch {
        // reintenta en el próximo tick
      }
    }, 500);
  }

  detailText(step: FlowStep): string | null {
    if (step.detail === undefined || step.detail === null) return null;
    return JSON.stringify(step.detail, null, 2);
  }

  stepFor(key: string): FlowStep | undefined {
    return this.steps().find((s) => s.step === key);
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer);
  }
}
