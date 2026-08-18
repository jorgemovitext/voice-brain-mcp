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

  /** Ruta del respaldo JSON. Vacío = default según entorno (ver abajo). */
  BRAIN_DATA_FILE: z.string().optional(),

  /**
   * URL pública del gateway; la usa el mock para llamarse a sí mismo
   * (/precall, /webhooks/*) igual que lo haría NL Pearl real.
   * En Vercel se deriva de VERCEL_URL si no se define.
   */
  PUBLIC_BASE_URL: z.string().optional(),

  /** Duración de la "conversación" simulada. Corta en serverless. */
  MOCK_CALL_DELAY_MS: z.coerce.number().int().nonnegative().optional(),

  /** Sembrar el directorio de demo al arrancar si el Brain está vacío. */
  SEED_ON_BOOT: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
});

export type AppConfig = z.infer<typeof configSchema> & {
  /** true en Vercel/Lambda: sin filesystem escribible ni timers de fondo. */
  SERVERLESS: boolean;
  BRAIN_DATA_FILE: string;
  PUBLIC_BASE_URL: string;
  MOCK_CALL_DELAY_MS: number;
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

  return {
    ...cfg,
    SERVERLESS: serverless,
    BRAIN_DATA_FILE: cfg.BRAIN_DATA_FILE ?? (serverless ? '/tmp/brain.json' : './data/brain.json'),
    PUBLIC_BASE_URL: publicBaseUrl,
    MOCK_CALL_DELAY_MS: cfg.MOCK_CALL_DELAY_MS ?? (serverless ? 800 : 6000),
  };
}
