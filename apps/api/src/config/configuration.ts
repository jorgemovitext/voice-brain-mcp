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

  BRAIN_DATA_FILE: z.string().default('./data/brain.json'),
});

export type AppConfig = z.infer<typeof configSchema>;

export function validateConfig(env: Record<string, unknown>): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida: ${parsed.error.message}`);
  }
  return parsed.data;
}
