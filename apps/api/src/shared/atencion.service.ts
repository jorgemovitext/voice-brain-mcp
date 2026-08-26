import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from './settings.service';

/**
 * Quién atiende una conversación: el agente de NL Pearl o una persona.
 *
 * Tomar un hilo es un compromiso, no una etiqueta: a partir de ahí el agente
 * ya no lo va a cerrar por nosotros, así que el operador se queda con la
 * conversación Y con las acciones que el flujo habría hecho solo (el ticket
 * en HubSpot, el aviso a la cuadrilla). Por eso se guarda quién la tomó y
 * desde cuándo — para que no quede un hilo huérfano sin dueño visible.
 */
export interface Atencion {
  /** null = la atiende el agente. */
  operador: string | null;
  desde?: string;
}

/** Clave por contacto: el estado es de la conversación, no global. */
const clave = (contactId: string) => `atencion:${contactId}`;

@Injectable()
export class AtencionService {
  private readonly logger = new Logger(AtencionService.name);

  constructor(private readonly settings: SettingsService) {}

  async de(contactId: string): Promise<Atencion> {
    return (await this.settings.get<Atencion>(clave(contactId))) ?? { operador: null };
  }

  /** Varias de una: el listado de conversaciones las necesita todas juntas. */
  async deVarios(contactIds: string[]): Promise<Map<string, Atencion>> {
    const pares = await Promise.all(
      contactIds.map(async (id) => [id, await this.de(id)] as const),
    );
    return new Map(pares.filter(([, a]) => a.operador));
  }

  async tomar(contactId: string, operador: string): Promise<Atencion> {
    const estado: Atencion = { operador, desde: new Date().toISOString() };
    await this.settings.set(clave(contactId), estado);
    this.logger.log(`${operador} tomó la conversación ${contactId}`);
    return estado;
  }

  async liberar(contactId: string): Promise<Atencion> {
    const estado: Atencion = { operador: null };
    await this.settings.set(clave(contactId), estado);
    this.logger.log(`Conversación ${contactId} devuelta al agente`);
    return estado;
  }
}
