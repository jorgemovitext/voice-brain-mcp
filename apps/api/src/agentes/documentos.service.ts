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
 * Lo que el proveedor sabe leer.
 *
 * La lista es blanca y no negra: un .xlsx o un .pptx sube igual y vuelve con
 * texto basura o vacío, y el operador se queda creyendo que el agente leyó la
 * tarifa. Mejor rechazarlo con un motivo que aceptarlo y mentir.
 */
const TIPOS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'text/plain': 'texto',
  'text/html': 'HTML',
  'application/epub+zip': 'EPUB',
};

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
 * Enseñarle a Fastify a recibir un PDF o un .docx tal cual.
 *
 * Por defecto rechaza con 415 cualquier cuerpo que no sea JSON, así que sin
 * esto no hay forma de subir un archivo.
 *
 * El tope va en el lector y no en el adaptador para no subirle el límite a
 * todo el resto de la API: un JSON de cuatro megas no es un caso de uso.
 */
export function aceptarArchivosCrudos(fastify: Pick<FastifyInstance, 'addContentTypeParser'>): void {
  for (const tipo of Object.keys(TIPOS)) {
    try {
      fastify.addContentTypeParser(
        tipo,
        { parseAs: 'buffer', bodyLimit: TOPE_BYTES + 64 * 1024 },
        (_req, cuerpo, hecho) => hecho(null, cuerpo),
      );
    } catch {
      /* Ya registrado por otro módulo: con un lector por tipo alcanza. */
    }
  }
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
  async subir(nombre: string, tipo: string, bytes: Buffer): Promise<DocumentoSubido> {
    if (!this.apiKey) throw new ServiceUnavailableException('Falta ELEVENLABS_API_KEY en el entorno.');

    const limpio = (nombre || 'Documento').trim().slice(0, 120);
    const formato = TIPOS[tipo.split(';')[0].trim()];
    if (!formato) {
      throw new BadRequestException(
        `No se puede leer un archivo de tipo «${tipo || 'desconocido'}». Subí un PDF o un Word.`,
      );
    }
    if (!bytes.length) throw new BadRequestException('El archivo llegó vacío.');
    if (bytes.length > TOPE_BYTES) {
      throw new BadRequestException(
        `«${limpio}» pesa más de ${Math.round(TOPE_BYTES / 1024 / 1024)} MB. Partilo o subí solo la parte que el agente necesita.`,
      );
    }

    const cuerpo = new FormData();
    cuerpo.append('file', new Blob([new Uint8Array(bytes)], { type: tipo }), limpio);
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

    this.logger.log(`Documento "${limpio}" (${formato}) subido: ${texto.length} caracteres`);
    return { referencia: id, nombre: limpio, palabras: DocumentosService.palabras(texto) };
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
