import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { ElevenLabsClient } from './elevenlabs.client';

/**
 * El turno con el agente, del lado de la lambda.
 *
 * Lo que se fija acá es lo que ya rompió en producción tres veces en este
 * proyecto: en serverless, todo lo que quede EN VUELO cuando la función
 * responde se congela y no se reanuda nunca. Una escritura a HubSpot a medio
 * camino no deja rastro de por qué el ticket no existe.
 */

/** WebSocket de mentira: deja manejar los mensajes del agente a mano. */
class FakeWebSocket {
  static ultima: FakeWebSocket;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  readonly enviados: string[] = [];
  cerrado = false;

  constructor() {
    FakeWebSocket.ultima = this;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string): void {
    // Igual que el real: mandar por un socket cerrado lanza.
    if (this.cerrado) throw new Error('WebSocket is not open');
    this.enviados.push(data);
  }

  close(): void {
    this.cerrado = true;
  }

  /** Simula un mensaje del agente hacia nosotros. */
  recibir(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('ElevenLabsClient · turno', () => {
  const original = globalThis.WebSocket;

  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    // Sin esto, `alAbrir` devuelve el socket de la prueba anterior —que ya
    // tiene mensajes— y se afirma contra el turno equivocado.
    FakeWebSocket.ultima = undefined as unknown as FakeWebSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  });

  function build() {
    const config = {
      get: (clave: string, porDefecto?: unknown) =>
        ({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'a' })[clave] ?? porDefecto,
    };
    const http = { get: () => of({ data: { signed_url: 'wss://falso' } }) };
    return new ElevenLabsClient(http as unknown as HttpService, config as unknown as ConfigService);
  }

  /** Espera a que el socket falso exista y esté abierto. */
  const alAbrir = async (): Promise<FakeWebSocket> => {
    for (let i = 0; i < 50 && !FakeWebSocket.ultima?.enviados.length; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    return FakeWebSocket.ultima;
  };

  it('NO devuelve el turno hasta que la herramienta terminó de escribir', async () => {
    /*
     * El caso real: el agente pide registrar_reporte, contesta al ciudadano
     * enseguida, y la escritura a HubSpot sigue corriendo. Antes se devolvía
     * ahí mismo — quien llama mandaba el WhatsApp, la lambda terminaba y
     * Vercel congelaba la instancia con el ticket a medio abrir.
     */
    const cliente = build();
    let terminarHerramienta!: () => void;
    /*
     * Se mide el ORDEN, no un estado: preguntar "¿ya escribió?" después de
     * soltar la herramienta pasa igual con el bug puesto, porque para cuando
     * se revisa ya corrió el microtask. Lo que importa es cuál de los dos
     * ocurre primero.
     */
    const orden: string[] = [];

    const turno = cliente.responder({
      texto: 'hay un derrumbe',
      ejecutarHerramienta: async () => {
        await new Promise<void>((r) => (terminarHerramienta = r));
        orden.push('escritura');
        return { ok: true, mensaje: 'Folio AMDC-1' };
      },
    });
    void turno.then(() => orden.push('turno'));

    const ws = await alAbrir();
    ws.recibir({
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'registrar_reporte', tool_call_id: 't1', parameters: {} },
    });
    // El agente contesta ANTES de que la escritura termine.
    ws.recibir({ type: 'agent_response', agent_response_event: { agent_response: 'Ya lo registré.' } });
    await new Promise((r) => setTimeout(r, 20));

    terminarHerramienta();
    const r = await turno;
    await new Promise((r2) => setTimeout(r2, 5));

    // Con el bug esto sale ['turno', 'escritura']: la lambda ya se habría ido.
    expect(orden).toEqual(['escritura', 'turno']);
    expect(r?.texto).toBe('Ya lo registré.');
  });

  it('si la herramienta termina con el socket ya cerrado, no revienta', async () => {
    // El trabajo YA se hizo: el ticket existe. Contarle al agente a esa altura
    // no sirve de nada, pero la excepción del send se volvía un rechazo sin
    // dueño que tumbaba el turno entero.
    const cliente = build();
    let terminar!: () => void;

    const turno = cliente.responder({
      texto: 'hola',
      ejecutarHerramienta: async () => {
        await new Promise<void>((r) => (terminar = r));
        return { ok: true, mensaje: 'listo' };
      },
    });

    const ws = await alAbrir();
    ws.recibir({
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'registrar_reporte', tool_call_id: 't1', parameters: {} },
    });
    ws.recibir({ type: 'agent_response', agent_response_event: { agent_response: 'Listo.' } });
    await new Promise((r) => setTimeout(r, 5));

    expect(ws.cerrado).toBe(true); // el turno ya cerró el socket
    terminar();

    await expect(turno).resolves.toMatchObject({ texto: 'Listo.' });
  });

  it('siempre le contesta al tool call, aunque la herramienta falle', async () => {
    // Un tool call sin respuesta deja al agente esperando hasta el reloj, y el
    // ciudadano se queda sin nada.
    const cliente = build();

    const turno = cliente.responder({
      texto: 'hola',
      ejecutarHerramienta: async () => {
        throw new Error('HubSpot 403');
      },
    });

    const ws = await alAbrir();
    ws.recibir({
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'registrar_reporte', tool_call_id: 't1', parameters: {} },
    });
    await new Promise((r) => setTimeout(r, 10));

    const respuesta = ws.enviados.map((e) => JSON.parse(e)).find((m) => m.type === 'client_tool_result');
    expect(respuesta).toMatchObject({ tool_call_id: 't1', is_error: true });
    expect(String(respuesta.result)).toContain('HubSpot 403');

    ws.recibir({ type: 'agent_response', agent_response_event: { agent_response: 'No se pudo.' } });
    await expect(turno).resolves.toMatchObject({ texto: 'No se pudo.' });
  });
});
