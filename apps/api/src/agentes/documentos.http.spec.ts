import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ElevenLabsClient } from '../elevenlabs/elevenlabs.client';
import { AgentesController } from './agentes.controller';
import { AgentesService } from './agentes.service';
import { AsistenteAgentesService } from './asistente.service';
import { aceptarArchivosCrudos, DocumentosService } from './documentos.service';

/**
 * Que un PDF llegue entero al controller.
 *
 * Esto no se puede verificar leyendo el código: Fastify rechaza con 415
 * cualquier cuerpo que no sea JSON hasta que se le registra un lector, y el
 * lector tiene que convivir con `rawBody: true`, que también se mete en los
 * parsers de contenido. Si no funcionara, subir un documento daría 415 en
 * producción y los tests de unidad seguirían verdes.
 *
 * Se levanta un Nest con adaptador Fastify de verdad y se le manda un archivo
 * por HTTP. El proveedor se corta en el servicio: lo que se prueba acá es el
 * camino, no la subida.
 */
describe('POST /api/agentes/documentos', () => {
  let app: NestFastifyApplication;
  let subir: jest.Mock;

  beforeAll(async () => {
    subir = jest.fn().mockResolvedValue({ referencia: 'doc-1', nombre: 'Reglamento.pdf', palabras: 12 });

    const modulo = await Test.createTestingModule({
      controllers: [AgentesController],
      providers: [
        { provide: DocumentosService, useValue: { subir } },
        { provide: AgentesService, useValue: {} },
        { provide: ElevenLabsClient, useValue: {} },
        { provide: AsistenteAgentesService, useValue: {} },
      ],
    }).compile();

    // `rawBody` como en los dos arranques: es lo que hacía dudar de si el
    // lector de binarios iba a poder convivir con él.
    app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      rawBody: true,
    });
    aceptarArchivosCrudos(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('recibe el PDF crudo como Buffer y le pasa el nombre de la query', async () => {
    const pdf = Buffer.from('%PDF-1.4 reglamento de aseo');

    const res = await app.inject({
      method: 'POST',
      url: '/api/agentes/documentos?nombre=Reglamento%20de%20Aseo.pdf',
      headers: { 'content-type': 'application/pdf' },
      payload: pdf,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ referencia: 'doc-1' });

    const [nombre, tipo, bytes] = subir.mock.calls[0];
    // El nombre va en la query y no en una cabecera porque "Reglamento de
    // Aseo.pdf" tiene espacios y acentos, y una cabecera HTTP no los admite.
    expect(nombre).toBe('Reglamento de Aseo.pdf');
    expect(tipo).toContain('application/pdf');
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(pdf)).toBe(true);
  });

  it('recibe un .docx, que es un zip y no sobrevive a un parser de texto', async () => {
    // Bytes de cabecera de zip, con un 0x00: si en el camino alguien lo tratara
    // como string, el archivo llegaría corrupto y el proveedor lo rechazaría.
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x14, 0x00]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agentes/documentos?nombre=reglamento.docx',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      payload: docx,
    });

    expect(res.statusCode).toBe(201);
    expect(subir.mock.calls.at(-1)![2].equals(docx)).toBe(true);
  });
});
