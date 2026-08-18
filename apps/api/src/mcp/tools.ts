import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainService } from '../brain/brain.service';
import { NlpearlCallContext } from '../brain/types';

/**
 * Tools MCP del Brain. Cada tool valida su input con zod y delega en
 * BrainService — la misma lógica que usa el gateway HTTP.
 */

/** Serializa cualquier resultado como contenido de texto MCP. */
function asResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerBrainTools(server: McpServer, brain: BrainService): void {
  server.registerTool(
    'brain_resolve_identity',
    {
      title: 'Resolver identidad unificada',
      description:
        'Resuelve (o crea) el contactId unificado a partir de un teléfono E.164 o un externalId de otro sistema.',
      inputSchema: {
        phone: z.string().optional().describe('Teléfono E.164, p. ej. +50588887777'),
        externalId: z.string().optional().describe('ID externo (lead de NL Pearl, sender, etc.)'),
        system: z.string().optional().describe('Sistema del externalId; default "nlpearl"'),
      },
    },
    async (args) => asResult(await brain.resolveIdentity(args)),
  );

  server.registerTool(
    'brain_get_context',
    {
      title: 'Obtener contexto unificado',
      description:
        'Devuelve el contexto completo de un contacto: datos, timeline cross-channel (voz/WhatsApp/SMS) y señales.',
      inputSchema: {
        contactId: z.string().optional(),
        phone: z.string().optional(),
        externalId: z.string().optional(),
      },
    },
    async (args) => asResult(await brain.getContext(args)),
  );

  server.registerTool(
    'brain_upsert_contact',
    {
      title: 'Crear o actualizar contacto',
      description: 'Crea o actualiza un contacto del Brain.',
      inputSchema: {
        id: z.string().optional(),
        displayName: z.string().optional(),
        phones: z.array(z.string()).optional(),
        externalIds: z.record(z.string(), z.string()).optional(),
        kycmStatus: z.enum(['verified', 'pending', 'unverified']).optional(),
      },
    },
    async (args) => asResult(await brain.upsertContact(args)),
  );

  server.registerTool(
    'brain_append_interaction',
    {
      title: 'Registrar interacción',
      description: 'Agrega una interacción (voz/whatsapp/sms) al timeline del contacto.',
      inputSchema: {
        contactId: z.string(),
        channel: z.enum(['voice', 'whatsapp', 'sms']),
        direction: z.enum(['inbound', 'outbound']),
        occurredAt: z.string().optional().describe('ISO 8601; default ahora'),
        summary: z.string().optional(),
        transcript: z.string().optional(),
        sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
        collectedInfo: z.record(z.string(), z.unknown()).optional(),
        source: z.enum(['nlpearl', 'own']).optional(),
      },
    },
    async (args) =>
      asResult(await brain.appendInteraction({ ...args, occurredAt: args.occurredAt ?? new Date().toISOString() })),
  );

  server.registerTool(
    'brain_set_signal',
    {
      title: 'Registrar señal',
      description: 'Crea o actualiza una señal (promesa de pago, flag, nota) del contacto.',
      inputSchema: {
        id: z.string().optional(),
        contactId: z.string(),
        type: z.enum(['promise', 'flag', 'note']),
        amount: z.number().optional(),
        dueDate: z.string().optional(),
        status: z.enum(['active', 'kept', 'broken']).optional(),
        text: z.string().optional(),
      },
    },
    async (args) => asResult(await brain.setSignal(args)),
  );

  server.registerTool(
    'brain_get_signals',
    {
      title: 'Listar señales',
      description: 'Lista las señales (promesas/flags/notas) de un contacto.',
      inputSchema: { contactId: z.string() },
    },
    async (args) => asResult(await brain.getSignals(args.contactId)),
  );

  server.registerTool(
    'brain_record_call_context',
    {
      title: 'Registrar contexto de llamada NL Pearl',
      description:
        'Normaliza y guarda el contexto de una llamada de NL Pearl (transcript, resumen, sentimiento, datos capturados) como interacción de voz.',
      inputSchema: {
        nlpearlCall: z
          .object({
            callId: z.string(),
            pearlId: z.string().optional(),
            phoneNumber: z.string().optional(),
            externalId: z.string().optional(),
            startedAt: z.string().optional(),
            endedAt: z.string().optional(),
            direction: z.enum(['inbound', 'outbound']).optional(),
            transcript: z.string().optional(),
            summary: z.string().optional(),
            sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
            collectedInfo: z.record(z.string(), z.unknown()).optional(),
            recordingUrl: z.string().optional(),
          })
          .describe('Llamada normalizada de NL Pearl'),
      },
    },
    async (args) => asResult(await brain.recordCallContext(args.nlpearlCall as NlpearlCallContext)),
  );

  server.registerTool(
    'brain_suggest_followup',
    {
      title: 'Sugerir seguimiento',
      description:
        'Genera el texto de seguimiento para un canal, usando la última promesa activa y el último resumen (determinista; hook opcional a LLM).',
      inputSchema: {
        contactId: z.string(),
        channel: z.enum(['whatsapp', 'sms']),
      },
    },
    async (args) => asResult({ suggestion: await brain.suggestFollowup(args.contactId, args.channel) }),
  );
}
