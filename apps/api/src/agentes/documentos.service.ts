import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyInstance } from 'fastify';

/**
 * Documentos como base de conocimiento de un agente.
 *
 * Un reglamento de aseo, un tarifario, el directorio de cuadrillas: cosas que
 * ya existen escritas y que nadie va a transcribir a mano dentro de un prompt.
 *
 * La extracción del texto —sacarle las letras a un PDF o a un .docx— la hace
 * el proveedor y no nosotros, a propósito: meter un parser de PDF en la lambda
 * suma dos dependencias nativas, infla el bundle y nos deja manteniendo el
 * caso raro (el PDF escaneado, la tabla a tres columnas) sin ganar nada. El
 * documento va a donde después va a ser consultado.
 *
 * Y la división del trabajo importa: el PROMPT lleva el comportamiento ("si
 * preguntan por horarios, consultá el reglamento") y la BASE DE CONOCIMIENTO
 * lleva el detalle, que se recupera por RAG solo cuando hace falta. Pegar el
 * reglamento entero dentro del prompt se paga en cada turno de cada llamada y
 * encima queda cortado.
 */

/** Un documento ya subido, como lo nombra la consola. */
export interface DocumentoSubido {
  /** La llave del proveedor. La consola la guarda pero NUNCA la muestra. */
  referencia: string;
  nombre: string;
  /** Para que el operador vea que se leyó algo y no un archivo vacío. */
  palabras: number;
}

/**
 * Qué se puede subir, por EXTENSIÓN y no por el tipo que declare el navegador.
 *
 * El navegador miente o calla: un `.md` llega como `text/markdown`, como
 * `text/plain` o vacío según el sistema; un `.docx` en Windows llega a veces
 * sin tipo. La extensión la escribió una persona y es lo único estable.
 *
 * El valor es el tipo con el que lo acepta el PROVEEDOR, que tiene su propia
 * lista blanca y es más corta: pdf, docx, epub, txt, html y markdown. Por eso
 * todo lo que es texto estructurado pero no está en esa lista —JSON, CSV,
 * YAML— se manda como `text/plain`: probado contra la cuenta, entra entero y
 * se lee bien. Mandado con su tipo propio, el proveedor devuelve 400.
 *
 * La lista es blanca y no negra: un .xlsx sube igual y vuelve con texto basura
 * o vacío, y el operador se queda creyendo que el agente leyó la tarifa. Mejor
 * rechazarlo con un motivo que aceptarlo y mentir.
 */
const FORMATOS: Record<string, { mime: string; como: string }> = {
  pdf: { mime: 'application/pdf', como: 'PDF' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    como: 'Word',
  },
  epub: { mime: 'application/epub+zip', como: 'EPUB' },
  html: { mime: 'text/html', como: 'HTML' },
  htm: { mime: 'text/html', como: 'HTML' },
  md: { mime: 'text/markdown', como: 'Markdown' },
  markdown: { mime: 'text/markdown', como: 'Markdown' },
  txt: { mime: 'text/plain', como: 'texto' },
  json: { mime: 'text/plain', como: 'JSON' },
  csv: { mime: 'text/plain', como: 'CSV' },
  yaml: { mime: 'text/plain', como: 'YAML' },
  yml: { mime: 'text/plain', como: 'YAML' },
  xml: { mime: 'text/plain', como: 'XML' },
  log: { mime: 'text/plain', como: 'texto' },
};

/**
 * Formatos que la gente intenta subir y que no se pueden, con la salida.
 *
 * Un "Invalid file type" del proveedor no le dice a nadie qué hacer. Un
 * ".doc es el Word viejo: guardalo como .docx" sí.
 */
const SALIDAS: Record<string, string> = {
  doc: 'es el Word viejo. Abrilo y guardalo como .docx.',
  pages: 'es de Pages. Exportalo a PDF o a Word.',
  xlsx: 'es una planilla y el texto sale revuelto. Exportá la hoja a CSV.',
  xls: 'es una planilla y el texto sale revuelto. Exportá la hoja a CSV.',
  numbers: 'es de Numbers. Exportá la hoja a CSV.',
  pptx: 'es una presentación. Exportala a PDF.',
  ppt: 'es una presentación. Exportala a PDF.',
  rtf: 'no se puede leer. Guardalo como .docx o como .txt.',
};

/** Lo que la consola pone en el selector de archivos. */
export const EXTENSIONES = Object.keys(FORMATOS).map((e) => `.${e}`);

/**
 * El único tipo con el que viaja un archivo desde la consola.
 *
 * Neutro a propósito. El lector que se registra en Fastify se queda con TODO
 * lo que llegue con ese tipo, así que registrar `application/json` —el tipo
 * real de un .json— dejaría a la API entera sin parsear JSON: cada endpoint
 * recibiría un Buffer donde espera un objeto. El tipo de verdad se deduce de
 * la extensión, que es más confiable igual.
 */
export const TIPO_TRANSPORTE = 'application/octet-stream';

/**
 * Tope de tamaño.
 *
 * No lo elegimos nosotros: Vercel corta el cuerpo de una petición en 4,5 MB y
 * ni se entera la aplicación. Se avisa ANTES de subir —en el navegador— porque
 * del otro lado del corte no hay mensaje que mandar.
 */
export const TOPE_BYTES = 4 * 1024 * 1024;

/** Cuánto del documento se le cuenta al constructor para que escriba el prompt. */
const EXTRACTO_CHARS = 4_000;

/**
 * Modelo de embeddings multilingüe.
 *
 * El que viene por defecto (`e5_mistral_7b_instruct`) está entrenado en
 * inglés: con un reglamento en español recupera los párrafos equivocados, que
 * es peor que no recuperar nada porque el agente contesta con seguridad.
 */
const EMBEDDINGS = 'multilingual_e5_large_instruct';

/**
 * Enseñarle a Fastify a recibir un archivo tal cual.
 *
 * Por defecto rechaza con 415 cualquier cuerpo que no sea JSON, así que sin
 * esto no hay forma de subir nada.
 *
 * UN solo tipo, y neutro: un lector se queda con todo lo que llegue con ese
 * Content-Type, para toda la aplicación. Registrar los tipos reales —
 * `application/json` para un .json, `text/plain` para un .txt— le sacaría el
 * parseo de JSON a la API entera.
 *
 * El tope va en el lector y no en el adaptador para no subirle el límite a
 * todo el resto de la API: un JSON de cuatro megas no es un caso de uso.
 */
export function aceptarArchivosCrudos(fastify: Pick<FastifyInstance, 'addContentTypeParser'>): void {
  fastify.addContentTypeParser(
    TIPO_TRANSPORTE,
    { parseAs: 'buffer', bodyLimit: TOPE_BYTES + 64 * 1024 },
    (_req, cuerpo, hecho) => hecho(null, cuerpo),
  );
}

@Injectable()
export class DocumentosService {
  private readonly logger = new Logger(DocumentosService.name);
  private readonly apiKey: string;
  private readonly apiUrl: string;

  /**
   * El texto ya extraído, por referencia.
   *
   * Es caché de proceso y no estado: el constructor necesita el texto en cada
   * turno de la charla para escribir el prompt, y volver a pedírselo al
   * proveedor cinco veces por el mismo documento son cinco viajes de red
   * dentro de los treinta segundos que tiene la lambda. Si la lambda arranca
   * en frío se vuelve a pedir y no se pierde nada.
   */
  private readonly textos = new Map<string, string>();

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    this.apiUrl = config.get<string>('ELEVENLABS_API_URL', 'https://api.elevenlabs.io');
  }

  /**
   * Sube el documento y le manda indexar.
   *
   * El índice RAG se dispara pero NO se espera ni se exige: tarda, y un
   * documento sin indexar igual sirve —el proveedor lo lee completo— mientras
   * termina. Si el plan no da para indexar, queda registrado en el log y el
   * documento se usa igual.
   */
  async subir(nombre: string, bytes: Buffer): Promise<DocumentoSubido> {
    if (!this.apiKey) throw new ServiceUnavailableException('Falta ELEVENLABS_API_KEY en el entorno.');

    const limpio = (nombre || 'Documento').trim().slice(0, 120);
    const formato = DocumentosService.formatoDe(limpio);

    if (!bytes.length) throw new BadRequestException(`«${limpio}» llegó vacío.`);
    if (bytes.length > TOPE_BYTES) {
      throw new BadRequestException(
        `«${limpio}» pesa más de ${Math.round(TOPE_BYTES / 1024 / 1024)} MB. Partilo o subí solo la parte que el agente necesita.`,
      );
    }

    const cuerpo = new FormData();
    cuerpo.append('file', new Blob([new Uint8Array(bytes)], { type: formato.mime }), limpio);
    cuerpo.append('name', limpio);

    const res = await fetch(`${this.apiUrl}/v1/convai/knowledge-base/file`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: cuerpo,
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 300);
      this.logger.warn(`No se pudo subir "${limpio}": ${res.status} ${detalle}`);
      throw new ServiceUnavailableException(`No se pudo guardar el documento: ${detalle}`);
    }
    const { id } = (await res.json()) as { id: string };

    const texto = await this.leerTexto(id);
    void this.indexar(id, limpio);

    this.logger.log(`Documento "${limpio}" (${formato.como}) subido: ${texto.length} caracteres`);
    return { referencia: id, nombre: limpio, palabras: DocumentosService.palabras(texto) };
  }

  /**
   * Con qué tipo mandarle el archivo al proveedor, según su extensión.
   *
   * Tira con un motivo accionable y no con el "Invalid file type" del
   * proveedor, que no le dice a nadie qué hacer con su .doc.
   */
  private static formatoDe(nombre: string): { mime: string; como: string } {
    const ext = (nombre.split('.').pop() ?? '').toLowerCase();
    const formato = FORMATOS[ext];
    if (formato) return formato;

    const salida = SALIDAS[ext];
    if (salida) throw new BadRequestException(`«${nombre}» ${salida}`);

    throw new BadRequestException(
      nombre.includes('.')
        ? `No se puede leer un archivo .${ext}. Se aceptan ${EXTENSIONES.join(', ')}.`
        : `«${nombre}» no tiene extensión y no hay cómo saber qué es. Ponele .pdf, .docx, .md o .txt.`,
    );
  }

  /**
   * Un pedazo del documento, para que el constructor sepa de qué habla.
   *
   * Va acotado porque no es el documento lo que tiene que entrar en el prompt
   * —para eso está la base de conocimiento— sino lo justo para que el
   * constructor reconozca el tema y escriba el comportamiento.
   */
  async extracto(referencia: string, tope = EXTRACTO_CHARS): Promise<string> {
    const texto = await this.leerTexto(referencia);
    return texto.length > tope ? `${texto.slice(0, tope)}\n[…sigue]` : texto;
  }

  private async leerTexto(referencia: string): Promise<string> {
    const guardado = this.textos.get(referencia);
    if (guardado !== undefined) return guardado;

    const res = await fetch(`${this.apiUrl}/v1/convai/knowledge-base/${referencia}/content`, {
      headers: { 'xi-api-key': this.apiKey },
    });
    if (!res.ok) {
      this.logger.warn(`No se pudo leer el contenido de ${referencia}: ${res.status}`);
      return '';
    }
    const texto = DocumentosService.aTextoPlano(await res.text());
    this.textos.set(referencia, texto);
    return texto;
  }

  private async indexar(referencia: string, nombre: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/v1/convai/knowledge-base/${referencia}/rag-index`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDINGS }),
      });
      if (!res.ok) {
        // No se corta la subida: sin índice el documento igual se consulta.
        this.logger.warn(`"${nombre}" quedó sin índice RAG: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      this.logger.warn(`"${nombre}" quedó sin índice RAG: ${(err as Error).message}`);
    }
  }

  /** El modelo de embeddings que tiene que declarar el agente que los consulta. */
  static get embeddings(): string {
    return EMBEDDINGS;
  }

  /**
   * El contenido viene como HTML; el constructor lee texto.
   *
   * Los cierres de párrafo se cambian por saltos ANTES de borrar las etiquetas:
   * si se borran todas de una, un reglamento de treinta artículos queda en un
   * solo renglón y el modelo no distingue dónde termina uno y empieza el otro.
   */
  private static aTextoPlano(html: string): string {
    return html
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private static palabras(texto: string): number {
    return texto ? texto.split(/\s+/).filter(Boolean).length : 0;
  }
}
