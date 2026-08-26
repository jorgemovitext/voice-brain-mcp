import { SettingsService } from './settings.service';
import { Global, Injectable, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FlushLogInterceptor } from './flush-log.interceptor';
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
  providers: [
    FlowLogService,
    WebhookLogService,
    SettingsService,
    AtencionService,
    /*
     * Va acá y no en main.ts: la función serverless monta AppModule por su
     * cuenta y nunca ejecuta main.ts, así que lo registrado allá no existe
     * en producción — que es justo donde hace falta.
     */
    { provide: APP_INTERCEPTOR, useClass: FlushLogInterceptor },
  ],
  exports: [FlowLogService, WebhookLogService, SettingsService, AtencionService],
})
export class SharedModule {}
