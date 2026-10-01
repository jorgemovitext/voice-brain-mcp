import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgenteActivoService } from '../shared/agente-activo.service';
import { AgentesService } from './agentes.service';
import { DocumentosService } from './documentos.service';

/**
 * Subir un documento como base de conocimiento, y engancharlo.
 *
 * Son dos pasos y el segundo es el que se olvida: un documento subido pero no
 * enganchado no rompe nada visiblemente —el agente contesta igual, inventando—
 * así que acá se verifica que el PATCH lleve el documento Y el RAG encendido.
 */

/** Un ConfigService con lo mínimo. */
function config(valores: Record<string, string> = {}): ConfigService {
  const base: Record<string, string> = {
    ELEVENLABS_API_KEY: 'k-de-prueba',
    ELEVENLABS_API_URL: 'https://proveedor.test',
    ...valores,
  };
  return { get: (clave: string, def?: string) => base[clave] ?? def ?? '' } as ConfigService;
}

/** Nadie eligió agente en la consola: nada está «en uso». */
const SIN_AGENTE_ACTIVO = { id: async () => '' } as unknown as AgenteActivoService;

describe('DocumentosService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const respuesta = (cuerpo: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => cuerpo,
    text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
  });

  it('rechaza un formato que el proveedor no sabe leer, sin subirlo', async () => {
    /*
     * Una planilla sube igual y vuelve con texto basura: el operador se queda
     * creyendo que el agente leyó la tarifa. Se corta ANTES del viaje de red.
     */
    const servicio = new DocumentosService(config());

    await expect(servicio.subir('tarifas.xlsx', Buffer.from('x'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('al rechazar, dice qué hacer en vez de "formato inválido"', async () => {
    // El "Invalid file type" del proveedor no le dice a nadie qué hacer con
    // su .doc. Este sí.
    const servicio = new DocumentosService(config());

    await expect(servicio.subir('acta.doc', Buffer.from('x'))).rejects.toThrow(/\.docx/);
    await expect(servicio.subir('tarifas.xlsx', Buffer.from('x'))).rejects.toThrow(/CSV/);
  });

  it('rechaza un archivo sin extensión: no hay cómo saber qué es', async () => {
    const servicio = new DocumentosService(config());
    await expect(servicio.subir('Reglamento', Buffer.from('x'))).rejects.toThrow(/extensión/);
  });

  it('rechaza un archivo más grande que el tope de la plataforma', async () => {
    // Vercel corta el cuerpo en 4,5 MB sin avisar: del otro lado del corte no
    // hay mensaje que mandar, así que se avisa acá.
    const servicio = new DocumentosService(config());
    const grande = Buffer.alloc(5 * 1024 * 1024);

    await expect(servicio.subir('reglamento.pdf', grande)).rejects.toThrow(/MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza un archivo vacío', async () => {
    const servicio = new DocumentosService(config());
    await expect(servicio.subir('vacio.pdf', Buffer.alloc(0))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sube, cuenta las palabras del texto extraído y pide el índice', async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta({ id: 'doc-1', name: 'Reglamento.pdf' }))
      .mockResolvedValueOnce(respuesta('<html><body><p>uno dos</p><p>tres</p></body></html>'))
      .mockResolvedValueOnce(respuesta({ status: 'new' }));

    const servicio = new DocumentosService(config());
    const r = await servicio.subir('Reglamento.pdf', Buffer.from('%PDF-'));

    expect(r).toEqual({ referencia: 'doc-1', nombre: 'Reglamento.pdf', palabras: 3 });

    const indexado = fetchMock.mock.calls.find((c) => String(c[0]).includes('rag-index'));
    expect(indexado).toBeDefined();
    // Multilingüe: el de por defecto está entrenado en inglés y con un
    // reglamento en español recupera los párrafos equivocados.
    expect(JSON.parse(indexado![1].body).model).toBe('multilingual_e5_large_instruct');
  });

  /**
   * El proveedor tiene su propia lista blanca —pdf, docx, epub, txt, html y
   * markdown— y nada más. Probado contra la cuenta: un .json mandado como
   * `application/json` vuelve 400; mandado como `text/plain` entra entero.
   */
  it.each([
    ['notas.md', 'text/markdown'],
    ['datos.json', 'text/plain'],
    ['zonas.csv', 'text/plain'],
    ['config.yaml', 'text/plain'],
    ['reglamento.pdf', 'application/pdf'],
    ['acta.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('manda %s al proveedor como %s', async (nombre, mime) => {
    fetchMock
      .mockResolvedValueOnce(respuesta({ id: 'doc-1', name: nombre }))
      .mockResolvedValueOnce(respuesta('<p>algo</p>'))
      .mockResolvedValueOnce(respuesta({ status: 'new' }));

    const servicio = new DocumentosService(config());
    await servicio.subir(nombre, Buffer.from('contenido'));

    const enviado = (fetchMock.mock.calls[0][1].body as FormData).get('file') as File;
    expect(enviado.type).toBe(mime);
  });

  it('se guía por la extensión aunque venga en mayúsculas', async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta({ id: 'doc-1', name: 'R.PDF' }))
      .mockResolvedValueOnce(respuesta('<p>algo</p>'))
      .mockResolvedValueOnce(respuesta({ status: 'new' }));

    const servicio = new DocumentosService(config());
    await expect(servicio.subir('R.PDF', Buffer.from('%PDF-'))).resolves.toMatchObject({
      referencia: 'doc-1',
    });
  });

  it('no tira si el índice RAG falla: el documento igual se consulta', async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta({ id: 'doc-1', name: 'R' }))
      .mockResolvedValueOnce(respuesta('<p>algo</p>'))
      .mockResolvedValueOnce(respuesta('rag limit exceeded', false, 403));

    const servicio = new DocumentosService(config());
    await expect(servicio.subir('R.pdf', Buffer.from('%PDF-'))).resolves.toMatchObject({
      referencia: 'doc-1',
    });
  });

  it('convierte el HTML del proveedor a texto con los párrafos separados', async () => {
    fetchMock.mockResolvedValueOnce(
      respuesta('<html><body><p>Art&iacute;culo 1.</p><p>Art 2 &amp; 3</p></body></html>'),
    );

    const servicio = new DocumentosService(config());
    const texto = await servicio.extracto('doc-1');

    /*
     * Los saltos importan: sin ellos un reglamento de treinta artículos queda
     * en un solo renglón y el modelo no distingue dónde termina uno.
     */
    expect(texto).toContain('\n');
    expect(texto).toContain('Art 2 & 3');
    expect(texto).not.toContain('<p>');
  });

  it('no vuelve a pedirle el contenido al proveedor por el mismo documento', async () => {
    // El constructor lo necesita en cada turno de la charla: cinco viajes de
    // red por el mismo documento dentro de los treinta segundos de la lambda.
    fetchMock.mockResolvedValueOnce(respuesta('<p>uno</p>'));

    const servicio = new DocumentosService(config());
    await servicio.extracto('doc-1');
    await servicio.extracto('doc-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('acota el extracto que se le cuenta al constructor', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(`<p>${'a'.repeat(9000)}</p>`));

    const servicio = new DocumentosService(config());
    const texto = await servicio.extracto('doc-1', 100);

    expect(texto.length).toBeLessThan(200);
    expect(texto).toContain('[…sigue]');
  });
});

describe('AgentesService.engancharDocumentos', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** Devuelve el agente tal como lo lee el servicio, y acepta el PATCH. */
  function cuentaCon(knowledgeBase: Array<{ id: string; name: string }> = []) {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            conversation_config: {
              agent: {
                prompt: { prompt: 'hola', knowledge_base: knowledgeBase, tools: [{ viejo: true }] },
              },
            },
          }),
      });
    });
  }

  /** El cuerpo del PATCH que se mandó al proveedor. */
  function patch(): Record<string, any> {
    const llamada = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
    return JSON.parse(llamada![1].body);
  }

  it('suma el documento y enciende RAG con el modelo con el que se indexó', async () => {
    /*
     * RAG viene apagado por defecto, y apagado el proveedor le mete el
     * documento ENTERO al prompt en cada turno: la llamada entera gastada en
     * leerse a sí misma. Y el modelo tiene que ser el mismo del índice, o no
     * hay nada que buscar.
     */
    cuentaCon();
    const servicio = new AgentesService(config(), SIN_AGENTE_ACTIVO);

    const nuevos = await servicio.engancharDocumentos('ag-1', [
      { referencia: 'doc-1', nombre: 'Reglamento de Aseo' },
    ]);

    expect(nuevos).toEqual(['Reglamento de Aseo']);
    const prompt = patch()['conversation_config']['agent']['prompt'];
    expect(prompt['knowledge_base']).toEqual([
      { type: 'file', name: 'Reglamento de Aseo', id: 'doc-1', usage_mode: 'auto' },
    ]);
    expect(prompt['rag']).toMatchObject({
      enabled: true,
      embedding_model: 'multilingual_e5_large_instruct',
    });
  });

  it('conserva los documentos que ya tenía', async () => {
    cuentaCon([{ id: 'doc-viejo', name: 'Tarifario' }]);
    const servicio = new AgentesService(config(), SIN_AGENTE_ACTIVO);

    await servicio.engancharDocumentos('ag-1', [{ referencia: 'doc-1', nombre: 'Reglamento' }]);

    const kb = patch()['conversation_config']['agent']['prompt']['knowledge_base'];
    expect(kb).toHaveLength(2);
    expect(kb[0]).toMatchObject({ id: 'doc-viejo' });
  });

  it('no engancha dos veces el mismo documento ni toca al agente', async () => {
    // Enganchado dos veces, RAG recupera el mismo párrafo duplicado. Se llama
    // en cada turno, así que esto no es un caso raro: es el caso normal.
    cuentaCon([{ id: 'doc-1', name: 'Reglamento' }]);
    const servicio = new AgentesService(config(), SIN_AGENTE_ACTIVO);

    const nuevos = await servicio.engancharDocumentos('ag-1', [
      { referencia: 'doc-1', nombre: 'Reglamento' },
    ]);

    expect(nuevos).toEqual([]);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PATCH')).toBe(false);
  });

  it('borra el arreglo viejo de herramientas, que no puede convivir con tool_ids', async () => {
    // La API rechaza el PATCH con "Cannot specify both".
    cuentaCon();
    const servicio = new AgentesService(config(), SIN_AGENTE_ACTIVO);

    await servicio.engancharDocumentos('ag-1', [{ referencia: 'doc-1', nombre: 'R' }]);

    expect(patch()['conversation_config']['agent']['prompt']['tools']).toBeUndefined();
  });

  it('sin documentos no llama al proveedor', async () => {
    cuentaCon();
    const servicio = new AgentesService(config(), SIN_AGENTE_ACTIVO);

    await servicio.engancharDocumentos('ag-1', []);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
