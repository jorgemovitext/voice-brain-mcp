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

        -- Qué agente (Pearl) atendió cada interacción.
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS handled_by text;

        -- CUÁL de los agentes atendió: handled_by dice el rol, esto la
        -- identidad. Es lo que deja separar lo de la Línea 100 de lo de Movi.
        -- NULL en lo histórico = lo atendió el agente del entorno.
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS agente text;

        -- Foto o ubicación que mandó la persona: el turno llega sin texto.
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS attachment text;
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS attachment_url text;
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS accion jsonb;

        -- Lo que el agente entendió del caso: alimenta la ficha, el resumen y
        -- el estado emocional del riel derecho. Sin esta columna el INSERT la
        -- descartaba en silencio y el riel se quedaba con el dato viejo.
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS ficha jsonb;

        -- Invitaciones: suman gente a TU organización, no a la consola.
        -- Se guarda el hash del código, nunca el código: una filtración de
        -- esta tabla no debe habilitar a nadie a entrar.
        -- Con el alta pública, dejan de ser la puerta y pasan a ser lo que
        -- son en cualquier SaaS: sumar un colega a tu espacio.
        CREATE TABLE IF NOT EXISTS invitations (
          id text PRIMARY KEY,
          code_hash text NOT NULL,
          phone text,
          nota text,
          creada_por text,
          creada timestamptz NOT NULL DEFAULT now(),
          expira timestamptz NOT NULL,
          usada timestamptz,
          usada_por text
        );
        ALTER TABLE invitations ADD COLUMN IF NOT EXISTS organizacion_id text;

        -- Una LÍNEA: el número de WhatsApp de un cliente y el agente que lo
        -- atiende. Es la unidad de Hive: cada cliente configura un número por
        -- agente, y todo lo demás (bandeja, tablero, cobro) cuelga de acá.
        -- 'destino' es la clave extra de routing cuando el proveedor no manda
        -- el número (p. ej. el nombre de app de Gupshup).
        CREATE TABLE IF NOT EXISTS lineas (
          id text PRIMARY KEY,
          cliente text NOT NULL,
          nombre text NOT NULL,
          numero text UNIQUE NOT NULL,
          destino text,
          agente text NOT NULL,
          estado text NOT NULL DEFAULT 'activa',
          creado timestamptz NOT NULL DEFAULT now()
        );

        -- Configuración editable desde la app (p. ej. qué Pearl usa cada canal),
        -- para no depender de variables de entorno que exigen redeploy.
        CREATE TABLE IF NOT EXISTS app_settings (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        -- Usuarios de la consola (auth: register/login/OTP).
        CREATE TABLE IF NOT EXISTS users (
          id text PRIMARY KEY,
          username text UNIQUE,
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
        -- Desde cuándo valen los tokens de esta cuenta.
        -- Un JWT no se puede revocar: vive hasta que expira. Esta marca es
        -- la revocación — se adelanta y todo token emitido antes muere.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_desde timestamptz;

        -- Tabla creada cuando el login era por teléfono: ahora identifica el usuario.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username);

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

        -- Una ORGANIZACIÓN: el negocio dueño de todo lo que ve una cuenta.
        -- Es lo que hace seguro el registro público: cada quien se registra
        -- y recibe SU espacio, vacío, sin ver el de nadie más.
        CREATE TABLE IF NOT EXISTS organizaciones (
          id text PRIMARY KEY,
          nombre text NOT NULL,
          plan text NOT NULL DEFAULT 'prueba',
          creada timestamptz NOT NULL DEFAULT now()
        );

        -- La organización de cada fila. Sin esto, abrir el registro sería
        -- entregarle a cualquiera los contactos y las conversaciones de los
        -- ciudadanos de otro cliente.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS organizacion_id text;

        -- Qué puede tocar cada quien. El primero de una empresa es su
        -- administrador: alguien tiene que poder invitar y configurar, y si
        -- nadie pudiera, la cuenta nace muerta.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS rol text NOT NULL DEFAULT 'operador';
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS organizacion_id text;
        ALTER TABLE interactions ADD COLUMN IF NOT EXISTS organizacion_id text;
        ALTER TABLE signals ADD COLUMN IF NOT EXISTS organizacion_id text;
        ALTER TABLE lineas ADD COLUMN IF NOT EXISTS organizacion_id text;

        -- Los filtros son por organización: sin índice, cada listado de la
        -- consola recorre la tabla entera.
        CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts (organizacion_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_org ON interactions (organizacion_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_signals_org ON signals (organizacion_id);
        CREATE INDEX IF NOT EXISTS idx_users_org ON users (organizacion_id);

        -- Qué organización es dueña de cada agente del proveedor. Los agentes
        -- viven en ElevenLabs, que no sabe de organizaciones: sin esta tabla,
        -- una cuenta nueva vería los agentes de todos los clientes.
        CREATE TABLE IF NOT EXISTS agentes_org (
          agente text PRIMARY KEY,
          organizacion_id text NOT NULL,
          creado timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_agentes_org ON agentes_org (organizacion_id);

        -- La historia anterior a las organizaciones tiene dueño explícito.
        -- En NULL se escondería de todos y parecería perdida; visible para
        -- cualquiera sería la fuga que esto evita.
        INSERT INTO organizaciones (id, nombre, plan)
          VALUES ('org-movitext', 'Movitext', 'interno')
          ON CONFLICT (id) DO NOTHING;
        UPDATE users SET organizacion_id = 'org-movitext' WHERE organizacion_id IS NULL;
        UPDATE contacts SET organizacion_id = 'org-movitext' WHERE organizacion_id IS NULL;
        UPDATE interactions SET organizacion_id = 'org-movitext' WHERE organizacion_id IS NULL;
        UPDATE signals SET organizacion_id = 'org-movitext' WHERE organizacion_id IS NULL;
        UPDATE lineas SET organizacion_id = 'org-movitext' WHERE organizacion_id IS NULL;

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
