import { z } from 'zod';

/**
 * Esquema de configuración validado con zod.
 * @nestjs/config invoca `validate` con process.env al arrancar;
 * si algo no cumple, la app no levanta.
 */
export const configSchema = z.object({
  MOCK: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  PORT: z.coerce.number().int().positive().default(3000),

  // NL Pearl v2 — vacíos en modo mock. Nunca hardcodear secretos.
  NLPEARL_BASE_URL: z.string().url().default('https://api.nlpearl.ai'),
  NLPEARL_ACCOUNT_ID: z.string().default(''),
  NLPEARL_API_KEY: z.string().default(''),
  NLPEARL_PEARL_ID: z.string().default(''),
  NLPEARL_WEBHOOK_SECRET: z.string().default(''),

  FOLLOWUP_CHANNEL: z.enum(['whatsapp', 'sms']).default('whatsapp'),

  /**
   * Auto-respuesta a mensajes entrantes:
   *  first  — solo al abrir la conversación o tras un silencio largo (default)
   *  always — en cada mensaje (repetitivo)
   *  off    — nunca; contesta el operador desde la consola
   */
  AUTO_REPLY_MODE: z.enum(['first', 'always', 'off']).default('first'),
  /** Horas sin auto-respuesta para volver a saludar en modo `first`. */
  AUTO_REPLY_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(12),

  /** Ruta del respaldo JSON. Vacío = default según entorno (ver abajo). */
  BRAIN_DATA_FILE: z.string().optional(),

  /**
   * Postgres (Neon vía integración de Vercel). Si está presente, el Brain y
   * la actividad NL Pearl persisten acá (prioridad sobre Blob y archivo).
   * Vercel la inyecta al conectar la DB: DATABASE_URL o POSTGRES_URL.
   */
  DATABASE_URL: z.string().default(''),

  // --- Autenticación de la consola ---
  /**
   * Secreto HS256 para firmar la cookie de sesión (JWT). OBLIGATORIO en
   * producción: sin él se genera uno efímero por proceso (las sesiones se
   * caen en cada cold start) y se loguea una advertencia.
   */
  AUTH_JWT_SECRET: z.string().default(''),
  /** Duración de la sesión en horas. */
  AUTH_SESSION_HOURS: z.coerce.number().positive().default(12),
  /** Vigencia del código OTP en minutos. */
  AUTH_OTP_TTL_MIN: z.coerce.number().positive().default(5),
  /** Respaldo local de usuarios cuando no hay Postgres (solo desarrollo). */
  AUTH_USERS_FILE: z.string().optional(),

  /**
   * Pearls de TEXTO (SMS/chat) de la cuenta, separadas por coma. Sus
   * conversaciones se registran como canal `sms` en el Brain. Además hay una
   * heurística por nombre (contiene "text" o "sms").
   * // TODO: confirmar con NL Pearl qué campo del Pearl distingue voz de texto
   */
  NLPEARL_TEXT_PEARL_IDS: z.string().default(''),

  /**
   * Token del Blob store de Vercel. Si está presente, el Brain persiste ahí y
   * el estado se comparte entre instancias serverless (lo carga Vercel solo
   * al conectar el store al proyecto).
   */
  BLOB_READ_WRITE_TOKEN: z.string().default(''),
  BRAIN_BLOB_PATH: z.string().default('brain/state.json'),

  /**
   * URL pública del gateway; la usa el mock para llamarse a sí mismo
   * (/precall, /webhooks/*) igual que lo haría NL Pearl real.
   * En Vercel se deriva de VERCEL_URL si no se define.
   */
  PUBLIC_BASE_URL: z.string().optional(),

  /** Duración de la "conversación" simulada. Corta en serverless. */
  MOCK_CALL_DELAY_MS: z.coerce.number().int().nonnegative().optional(),

  /**
   * Sembrar el directorio de demo al arrancar si el Brain está vacío.
   * Sin definir: sigue a MOCK (en modo real el Brain arranca vacío).
   */
  SEED_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.toLowerCase() !== 'false')),

  // --- WhatsApp vía Gupshup (BSP) — proveedor preferido si está configurado ---
  GUPSHUP_API_URL: z.string().default('https://api.gupshup.io/wa/api/v1/msg'),
  /** Gupshup → Dashboard → API key. */
  GUPSHUP_API_KEY: z.string().default(''),
  /** Nombre de la app en Gupshup (viaja como src.name). */
  GUPSHUP_APP_NAME: z.string().default(''),
  /** Número emisor registrado en Gupshup, sin '+' (ej. 917834811114). */
  GUPSHUP_SOURCE_NUMBER: z.string().default(''),

  // --- WhatsApp Cloud API (Meta directo) — alternativa a Gupshup ---
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  /** ID del número emisor (Meta → WhatsApp → API Setup). */
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  /** Access token (permanente del System User, o temporal de pruebas). */
  WHATSAPP_TOKEN: z.string().default(''),
  /** Lo definís vos; Meta lo repite al verificar el webhook. */
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  /** App Secret: valida la firma X-Hub-Signature-256 de cada evento. */
  WHATSAPP_APP_SECRET: z.string().default(''),
});

export type AppConfig = z.infer<typeof configSchema> & {
  /** true en Vercel/Lambda: sin filesystem escribible ni timers de fondo. */
  SERVERLESS: boolean;
  BRAIN_DATA_FILE: string;
  AUTH_USERS_FILE: string;
  PUBLIC_BASE_URL: string;
  MOCK_CALL_DELAY_MS: number;
  SEED_ON_BOOT: boolean;
};

export function validateConfig(env: Record<string, unknown>): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida: ${parsed.error.message}`);
  }
  const cfg = parsed.data;

  // En serverless el proceso se congela tras responder (no corren timers de
  // fondo) y solo /tmp es escribible: los defaults se ajustan a eso.
  const serverless = Boolean(env['VERCEL'] ?? env['AWS_LAMBDA_FUNCTION_NAME']);

  const publicBaseUrl =
    cfg.PUBLIC_BASE_URL ??
    (env['VERCEL_URL'] ? `https://${env['VERCEL_URL'] as string}` : `http://localhost:${cfg.PORT}`);

  // Al conectar un Blob store, Vercel nombra la variable según el prefijo que
  // le hayas puesto: `<PREFIJO>_READ_WRITE_TOKEN`. Se acepta el nombre estándar
  // o cualquier variante con ese sufijo, para no depender de cómo se llamó.
  const blobToken =
    cfg.BLOB_READ_WRITE_TOKEN ||
    (Object.entries(env).find(
      ([key, value]) => key.endsWith('_READ_WRITE_TOKEN') && typeof value === 'string' && value,
    )?.[1] as string | undefined) ||
    '';

  // Igual que con Blob: la integración de Neon puede nombrar la variable con
  // prefijo (<PREFIJO>_DATABASE_URL / POSTGRES_URL). Se prefiere la variante
  // "pooled" si existe, que es la indicada para serverless.
  const databaseUrl =
    cfg.DATABASE_URL ||
    (env['POSTGRES_URL'] as string | undefined) ||
    (Object.entries(env).find(
      ([key, value]) =>
        (key.endsWith('_DATABASE_URL') || key.endsWith('_POSTGRES_URL')) &&
        !key.includes('UNPOOLED') &&
        !key.includes('NON_POOLING') &&
        typeof value === 'string' &&
        (value as string).startsWith('postgres'),
    )?.[1] as string | undefined) ||
    '';

  return {
    ...cfg,
    BLOB_READ_WRITE_TOKEN: blobToken,
    DATABASE_URL: databaseUrl,
    SERVERLESS: serverless,
    BRAIN_DATA_FILE: cfg.BRAIN_DATA_FILE ?? (serverless ? '/tmp/brain.json' : './data/brain.json'),
    AUTH_USERS_FILE: cfg.AUTH_USERS_FILE ?? (serverless ? '/tmp/users.json' : './data/users.json'),
    PUBLIC_BASE_URL: publicBaseUrl,
    MOCK_CALL_DELAY_MS: cfg.MOCK_CALL_DELAY_MS ?? (serverless ? 800 : 6000),
    // Los contactos de demo solo tienen sentido en modo simulado.
    SEED_ON_BOOT: cfg.SEED_ON_BOOT ?? cfg.MOCK,
  };
}
