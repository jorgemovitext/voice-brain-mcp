import { SettingsService } from './settings.service';
import { Global, Injectable, Module } from '@nestjs/common';
import { AtencionService } from './atencion.service';
import { WebhookLogService } from './webhook-log.service';

export interface FlowStep {
  at: string;
  step: string; // clave estable, p. ej. "precall"
  title: string; // texto para la consola
  detail?: unknown;
}

/**
 * Log de eventos del flujo demo. Es un servicio global mínimo para que
 * precall/webhook/canales puedan reportar pasos sin acoplarse a DemoModule
 * (evita dependencias circulares). La consola lo lee vía GET /demo/status.
 */
@Injectable()
export class FlowLogService {
  private steps: FlowStep[] = [];
  private running = false;

  start(): void {
    this.steps = [];
    this.running = true;
  }

  push(step: string, title: string, detail?: unknown): void {
    this.steps.push({ at: new Date().toISOString(), step, title, detail });
  }

  finish(): void {
    this.running = false;
  }

  snapshot(): { running: boolean; steps: FlowStep[] } {
    return { running: this.running, steps: [...this.steps] };
  }
}

@Global()
@Module({
  providers: [FlowLogService, WebhookLogService, SettingsService, AtencionService],
  exports: [FlowLogService, WebhookLogService, SettingsService, AtencionService],
})
export class SharedModule {}
