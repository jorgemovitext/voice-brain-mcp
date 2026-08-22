import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

/**
 * Pool de Postgres compartido (Neon vía integración de Vercel).
 *
 * Si DATABASE_URL no está configurada el token resuelve a `null` y cada
 * consumidor degrada solo (Brain cae a Blob/archivo; la actividad NL Pearl
 * no se almacena en raw). Así la app levanta igual sin DB.
 */
export const PG_POOL = 'PgPool';

/** Una sola creación de esquema por instancia, compartida entre repos. */
const schemaListo = new WeakMap<Pool, Promise<void>>();

export function ensureSchema(pool: Pool): Promise<void> {
  let ready = schemaListo.get(pool);
  if (!ready) {
    ready = pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS contacts (
          id text PRIMARY KEY,
          display_name text,
          phones jsonb NOT NULL DEFAULT '[]',
          external_ids jsonb NOT NULL DEFAULT '{}',
          kycm_status text
        );
        CREATE TABLE IF NOT EXISTS interactions (
          id text PRIMARY KEY,
          contact_id text NOT NULL,
          channel text NOT NULL,
          direction text NOT NULL,
          occurred_at timestamptz NOT NULL,
          summary text,
          transcript text,
          sentiment text,
          collected_info jsonb,
          source text
        );
        CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions (contact_id, occurred_at DESC);
        CREATE TABLE IF NOT EXISTS signals (
          id text PRIMARY KEY,
          contact_id text NOT NULL,
          type text NOT NULL,
          amount numeric,
          due_date text,
          status text,
          body text
        );
        CREATE INDEX IF NOT EXISTS idx_signals_contact ON signals (contact_id);

        -- Usuarios de la consola (auth: register/login/OTP).
        CREATE TABLE IF NOT EXISTS users (
          id text PRIMARY KEY,
          phone text UNIQUE NOT NULL,
          name text,
          password_hash text NOT NULL,
          verified boolean NOT NULL DEFAULT false,
          failed_logins integer NOT NULL DEFAULT 0,
          locked_until timestamptz,
          otp_hash text,
          otp_expires_at timestamptz,
          otp_attempts integer NOT NULL DEFAULT 0,
          otp_last_sent_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        -- Espejo NL Pearl: catálogo de pearls y actividad raw a detalle.
        CREATE TABLE IF NOT EXISTS nlpearl_pearls (
          id text PRIMARY KEY,
          name text,
          type integer,
          status integer,
          agent_type integer,
          channel text NOT NULL DEFAULT 'voice',
          raw jsonb,
          synced_at timestamptz NOT NULL DEFAULT now()
        );
        -- Tablas creadas antes de conocer agentType (1=voz, 2=texto).
        ALTER TABLE nlpearl_pearls ADD COLUMN IF NOT EXISTS agent_type integer;
        CREATE TABLE IF NOT EXISTS nlpearl_activity (
          id text PRIMARY KEY,
          pearl_id text,
          phone text,
          kind text NOT NULL DEFAULT 'call',
          occurred_at timestamptz,
          raw jsonb NOT NULL,
          ingested_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_nlpearl_activity_pearl ON nlpearl_activity (pearl_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_nlpearl_activity_phone ON nlpearl_activity (phone);
        `,
      )
      .then(() => undefined);
    schemaListo.set(pool, ready);
  }
  return ready;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool | null => {
        const url = config.get<string>('DATABASE_URL', '');
        if (!url) return null;
        new Logger('DatabaseModule').log('Postgres configurado (pool compartido)');
        return new Pool({
          connectionString: url,
          // Neon exige TLS; en local (localhost) no suele haber certificado.
          ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
          // Serverless: conexiones mínimas y de vida corta; el pooling real
          // lo hace el endpoint "-pooler" de Neon.
          max: 3,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 8_000,
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
