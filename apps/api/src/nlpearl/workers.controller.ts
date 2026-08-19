import { Controller, Get, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NlpearlClient } from './nlpearl.client';

/**
 * "Obreros": los Pearls (agentes de voz) de la cuenta NL Pearl, vistos como
 * fuerza de trabajo. Solo lecturas — nada de acá gasta llamadas ni créditos.
 *
 * El shape exacto del Pearl no está documentado del todo, así que se
 * normalizan los campos conocidos y el resto viaja en `raw` para inspección.
 */

interface Worker {
  id: string;
  name: string;
  status?: string;
  type?: string;
  raw: Record<string, unknown>;
}

/**
 * Estados numéricos observados en la cuenta real: el Pearl activo reporta 1
 * y los demás 2. // TODO: confirmar el enum completo con NL Pearl.
 */
function mapStatus(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  if (s === '1') return 'active';
  if (s === '2') return 'paused';
  return s;
}

/** Campos que suelen traer estado/tipo en la API v2, en orden de preferencia. */
function normalizeWorker(p: Record<string, unknown>): Worker {
  const id = String(p['id'] ?? p['pearlId'] ?? '');
  const name = String(p['name'] ?? p['pearlName'] ?? 'sin nombre');

  const rawStatus = mapStatus(p['activityState'] ?? p['status'] ?? p['state']);
  const rawType = p['type'] ?? p['pearlType'] ?? p['direction'];

  // Sin no primitivos ni campos gigantes: el detalle completo va aparte.
  const raw = Object.fromEntries(
    Object.entries(p).filter(
      ([, v]) => v !== null && ['string', 'number', 'boolean'].includes(typeof v),
    ),
  );

  return {
    id,
    name,
    status: rawStatus !== undefined ? String(rawStatus) : undefined,
    type: rawType !== undefined ? String(rawType) : undefined,
    raw,
  };
}

const MOCK_WORKERS: Worker[] = [
  {
    id: 'pearl_mock_recepcion',
    name: 'Recepcionista Movitext (mock)',
    status: 'active',
    type: 'inbound',
    raw: { id: 'pearl_mock_recepcion', name: 'Recepcionista Movitext (mock)', language: 'es', voice: 'Camila' },
  },
  {
    id: 'pearl_mock_sdr',
    name: 'SDR LATAM (mock)',
    status: 'active',
    type: 'outbound',
    raw: { id: 'pearl_mock_sdr', name: 'SDR LATAM (mock)', language: 'es', voice: 'Diego' },
  },
  {
    id: 'pearl_mock_cobros',
    name: 'Cobranzas (mock)',
    status: 'paused',
    type: 'outbound',
    raw: { id: 'pearl_mock_cobros', name: 'Cobranzas (mock)', language: 'es', voice: 'Marta' },
  },
];

/** Flow de ejemplo para el modo mock, con la forma de un grafo PearlVibe. */
const MOCK_FLOW = {
  nodes: [
    { id: 'n1', type: 'PreCallAPI', label: 'PreCallAPI → /precall (contexto del Brain)' },
    { id: 'n2', type: 'OpeningSentence', label: 'Saludo con nombre y motivo' },
    { id: 'n3', type: 'Conversation', label: 'Negociación de promesa de pago' },
    { id: 'n4', type: 'CollectInfo', label: 'Captura promiseAmount / promiseDate' },
    { id: 'n5', type: 'EndCall', label: 'Despedida + confirma seguimiento por WhatsApp' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
    { from: 'n4', to: 'n5' },
  ],
};

@Controller('api/workers')
export class WorkersController {
  private readonly mock: boolean;

  constructor(private readonly client: NlpearlClient, config: ConfigService) {
    this.mock = config.get<boolean>('MOCK', true);
  }

  /** El Pearl activo (NLPEARL_PEARL_ID) viaja para resaltarlo en la vista. */
  @Get()
  async list(): Promise<{ workers: Worker[]; inUseId: string }> {
    if (this.mock) return { workers: MOCK_WORKERS, inUseId: 'pearl_mock_recepcion' };

    this.client.assertConfigured();
    const res = (await this.client.getPearls()) as unknown;
    const items = Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? []);
    return {
      workers: (items as Array<Record<string, unknown>>).map(normalizeWorker),
      inUseId: this.client.pearlId,
    };
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<Worker> {
    if (this.mock) return MOCK_WORKERS.find((w) => w.id === id) ?? MOCK_WORKERS[0];
    this.client.assertConfigured();
    const pearl = (await this.client.getPearl(id)) as Record<string, unknown>;
    return normalizeWorker(pearl ?? {});
  }

  /**
   * Workflow (flow) del Pearl. El endpoint de PearlFlow no está confirmado en
   * la doc pública, así que puede no estar disponible: se responde con
   * available:false en vez de propagar el error.
   */
  @Get(':id/flow')
  async flow(@Param('id') id: string): Promise<{ available: boolean; flow?: unknown; message?: string }> {
    if (this.mock) return { available: true, flow: MOCK_FLOW };

    try {
      this.client.assertConfigured();
      const flow = await this.client.getPearlSettings(id);
      return { available: true, flow };
    } catch (err) {
      return {
        available: false,
        message:
          'NL Pearl no expuso el flow por API (endpoint por confirmar). ' +
          `Se edita en PearlVibe. Detalle: ${(err as Error).message}`,
      };
    }
  }
}
