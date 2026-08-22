import { Injectable } from '@nestjs/common';
import { NlpearlCallContext } from '../brain/types';
import { StartCallInput, VoiceEnginePort } from '../ports/voice-engine.port';
import { NlpearlClient } from './nlpearl.client';
import { toCallContext } from './nlpearl.mapper';
import { PearlRoutingService } from './pearl-routing.service';

/**
 * Implementación REAL del puerto de voz sobre el cliente NL Pearl v2.
 * En v2 la llamada saliente se dispara agregando un lead al Pearl outbound.
 */
@Injectable()
export class NlpearlVoiceEngine implements VoiceEnginePort {
  constructor(
    private readonly client: NlpearlClient,
    private readonly routing: PearlRoutingService,
  ) {}

  async startCall(input: StartCallInput): Promise<{ leadId: string }> {
    this.client.assertConfigured();
    // El Pearl sale de la elección puntual, o de la asignada al canal de voz.
    const pearlId = await this.routing.resolve('voice', input.pearlId);
    const lead = await this.client.addLead(pearlId, {
      phoneNumber: input.phone,
      externalId: input.externalId, // llave de unión: nuestro contactId
      callData: input.variables,
    });
    return { leadId: lead.id };
  }

  async getCallContext(callId: string): Promise<NlpearlCallContext> {
    this.client.assertConfigured();
    const call = await this.client.getCall(callId);
    return toCallContext(call);
  }
}
