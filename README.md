# Voice Brain MCP — Prototipo Voz (NL Pearl v2) + Brain (MCP) + Canales

Prototipo de **gateway de voz** sobre NL Pearl v2 con un **"Brain"** de contexto
unificado por contacto (independiente del canal), expuesto también como
**servidor MCP**, y una **consola Angular 22** para operar el flujo.

Corre **end-to-end en modo mock sin credenciales**. Los adaptadores reales de
NL Pearl v2 están listos para conectar.

## Qué hace

- **Voz**: NL Pearl v2 como motor detrás de nuestro propio gateway (no se usa
  su consola ni sus canales de texto). La llamada saliente se dispara con
  `addLead`; antes de hablar, el nodo **PreCallAPI** pide contexto a
  `POST /precall`; al terminar, el **webhook** `POST /webhooks/nlpearl` trae el
  aviso y el gateway recupera transcripción/resumen/sentimiento/datos.
- **Brain**: contexto unificado por contacto (identidad, timeline
  cross-channel, señales tipo promesa de pago). Expuesto por REST para la
  consola y como **servidor MCP (stdio)** con tools `brain_*`.
- **Canales propios**: WhatsApp/SMS (stubs con hueco para WABA/proveedor SMS)
  leen y escriben el mismo contexto → el seguimiento continúa el mismo hilo.

## Diagrama del flujo (demo)

```
 consola /demo ──POST /api/demo/run──▶ DemoService
   1. siembra contacto (promesa activa + WhatsApp previo)
   2. addLead (VoiceEnginePort → mock | NL Pearl v2)
        │
        ▼  (ciclo de llamada)
   3. POST /precall  ◀── nodo PreCallAPI      → variables (nombre, promesa, saldo, último resumen)
   4. ... conversación ...
   5. POST /webhooks/nlpearl (HMAC guard)     → getCall → Brain.recordCallContext
        │                                        · interacción voice + señal promesa
        ▼
   6. FollowupService → brain_suggest_followup → WhatsApp propio (stub)
        │                                        · interacción whatsapp outbound
        ▼
   7. consola: timeline del contacto con voz + WhatsApp en el mismo hilo
```

## Estructura

```
voice-brain-mcp/
├─ apps/
│  ├─ api/        # NestJS 11 + Fastify: Brain, NL Pearl, canales, MCP, demo
│  └─ console/    # Angular 22 (signals + zoneless). Vistas:
│                 #   /home           inicio con avatar de voz
│                 #   /contacts       directorio de contactos
│                 #   /contacts/:id   chat + contexto en vivo (2 columnas)
│                 #   /conversations  módulo de conversaciones: lista de hilos
│                 #                   + chat + contexto en vivo (3 columnas)
│                 #   /demo           flujos end-to-end paso a paso
├─ scripts/run-demo.mjs
├─ data/brain.json   # respaldo de persistencia (se crea al correr)
└─ .env              # copiar de .env.example
```

## Cómo correr

Requisitos: **Node 20+** (probado con Node 24).

```bash
cp .env.example .env     # MOCK=true por defecto
npm install

npm run dev              # api (3000) + consola (4200) juntos
# o por separado:
npm run dev:api
npm run dev:console
```

- Consola: **http://localhost:4200** → pestaña **Demo del flujo** → “Correr
  flujo end-to-end”. Al final hay link al contexto del contacto (voz + WhatsApp
  en el mismo timeline).
- Demo por CLI (con la api levantada): `npm run demo`
- Tests: `npm test` · Build: `npm run build`

## Desplegado

**https://voice-brain-mcp.vercel.app** — corre en modo mock, sin credenciales.

## Desplegar en Vercel (desde GitHub)

El repo ya trae `vercel.json` y la función serverless en `api/index.js`.

```bash
git init && git add -A && git commit -m "Prototipo voz + Brain MCP"
git remote add origin git@github.com:<usuario>/<repo>.git
git push -u origin main
```

En Vercel: **Add New → Project → Import** ese repo y **Deploy**. `vercel.json`
define el build, publica la consola Angular como estático y rutea `/api/*`,
`/precall` y `/webhooks/*` a la función Nest.

> **Un solo proyecto, con Root Directory en la raíz del repo.** El build tolera
> que Vercel arranque dentro de un workspace, pero la función serverless vive
> en `api/index.js` (raíz) y Vercel solo la detecta si el Root Directory es esa
> raíz. Con proyectos separados por workspace, la consola se despliega pero
> `/api/*` responde 404.

> **Por qué el build es un script y no `npm run --workspace`** (dos trampas de
> Vercel con monorepos npm, ambas ya resueltas en `scripts/vercel-build.sh`):
>
> - Un script llamado `vercel-build` en el `package.json` raíz **no** sirve:
>   Vercel le da trato especial y npm lo propaga a cada workspace, que no lo
>   define → `Missing script: "vercel-build"`.
> - `npm run build --workspace apps/api` falla con `No workspaces found` si
>   Vercel ejecuta el build desde un subdirectorio. El script localiza la raíz
>   del monorepo por su cuenta y llama a `nest`/`ng` con `npx`, así funciona
>   desde cualquier ubicación.
>
> Si el deploy vuelve a fallar, mirá las primeras líneas del log: el script
> imprime `cwd inicial` y `raíz del monorepo`, que dicen exactamente desde
> dónde arrancó Vercel.

Variables de entorno (Project → Settings → Environment Variables): **ninguna es
obligatoria** — sin nada, el deploy corre en modo mock. Para conectar NL Pearl
real, cargá `MOCK=false`, `NLPEARL_ACCOUNT_ID`, `NLPEARL_API_KEY`,
`NLPEARL_PEARL_ID` y `NLPEARL_WEBHOOK_SECRET`, y apuntá el webhook del Pearl a
`https://<tu-deploy>.vercel.app/webhooks/nlpearl` y el nodo PreCallAPI a
`https://<tu-deploy>.vercel.app/precall`.

### Qué cambia en serverless (y por qué)

Vercel congela el proceso al responder y solo `/tmp` es escribible, así que el
código se adapta solo (detecta `VERCEL`):

- **Persistencia**: con un **Vercel Blob store** conectado (Storage → Create →
  Blob), el Brain guarda un único JSON compartido por todas las instancias y
  el estado deja de perderse. Vercel inyecta `BLOB_READ_WRITE_TOKEN` solo y el
  código lo detecta. **Sin store**, cae al archivo en `/tmp`: cada lambda tiene
  su propia copia, así que un contacto creado en una instancia no existe en la
  siguiente y los mensajes que entran por webhook no aparecen en la consola.
- **Sembrado en frío**: si el Brain arranca vacío se siembra el directorio de
  demo con **IDs fijos**, para que los enlaces `/contacts/:id` sigan valiendo
  entre instancias.
- **Flujo demo**: se completa dentro del request (no hay timers de fondo) y los
  pasos viajan en la respuesta, porque el polling podría caer en otra instancia.
- **Mock**: usa los servicios in-process en vez de llamarse por HTTP a sí mismo
  (la protección de deployments bloquearía ese self-request). En local sigue
  usando HTTP real contra `/precall` y `/webhooks/nlpearl`.
- **MCP**: el servidor stdio no aplica en Vercel; corre local con `npm run mcp`.

## Brain como servidor MCP

```bash
npm run mcp                                    # servidor stdio
npx @modelcontextprotocol/inspector npm run mcp  # probarlo con el inspector
```

Tools: `brain_resolve_identity`, `brain_get_context`, `brain_upsert_contact`,
`brain_append_interaction`, `brain_set_signal`, `brain_get_signals`,
`brain_record_call_context`, `brain_suggest_followup`.

Comparte persistencia (archivo JSON) con el gateway HTTP.

## Conectar NL Pearl real

1. En `.env`: `MOCK=false`, `NLPEARL_ACCOUNT_ID`, `NLPEARL_API_KEY` y
   `NLPEARL_PEARL_ID` (Pearl outbound de voz).
   Auth confirmada en docs: `Authorization: Bearer {AccountId}:{SecretKey}`.
2. En NL Pearl: configurar el flujo del Pearl con nodo **PreCallAPI** apuntando
   a `https://tu-host/precall`, y activar el webhook de llamada apuntando a
   `https://tu-host/webhooks/nlpearl`.

   Dónde está el webhook (no es workspace-wide, es **por Pearl**):
   dashboard (salí de Settings con *Go Back*) → abrí tu Pearl → editor de flujo
   **PearlVibe** → pestaña **Outbound Settings** (o *Inbound Settings*) →
   grupo **Campaign Settings** → bajá hasta el final, sección **Webhooks** →
   activá el toggle (los campos de URL solo aparecen al habilitarlo) →
   **Call Webhook URL**. El *Lead Webhook* no lo usamos.
   Ojo: en Settings del workspace, **Agent(s)** es capacidad de llamadas
   simultáneas, no los Pearls; y **Text Channels** no se usa (WhatsApp/SMS
   son nuestros).
3. `NLPEARL_WEBHOOK_SECRET`: NL Pearl no firma webhooks con HMAC — al
   configurar el webhook podés adjuntar un **Credential** (un token que creás
   vos) que viaja en cada entrega. Poné ese mismo valor en
   `NLPEARL_WEBHOOK_SECRET` y el guard lo verificará; vacío = no se exige.
3. Los paths confirmados contra la doc v2 están en
   `apps/api/src/nlpearl/nlpearl.client.ts`; los no verificados quedaron
   marcados `// TODO: confirmar con NL Pearl` (igual que el shape exacto del
   webhook y del PreCallAPI en `webhook.controller.ts` / `precall.controller.ts`).

## Espejo NL Pearl (todos los canales) + Postgres

Desde el pivote de 2026-08, la plataforma consume **todos** los canales de
NL Pearl (voz y texto: SMS "Línea 100 AMDC TEXT", WhatsApp, etc.) y almacena
la atención a detalle en DB propia.

- **Sync multi-pearl**: `POST /api/nlpearl/sync` recorre todas las pearls de
  la cuenta, trae la actividad con `Calls/Bulk` (paginado, límite 100 del API)
  y guarda el raw completo + la interacción normalizada en el Brain. La
  consola lo dispara sola cada ~30 s (`?soft=true`, con rate-limit).
  `GET /api/nlpearl/activity` y `GET /api/nlpearl/pearls` exponen lo espejado.
- **Canal por pearl**: nombre con "Whatsapp" ⇒ `whatsapp`, "TEXT/SMS/Chat" ⇒
  `sms`, resto ⇒ `voice`. Se puede forzar con `NLPEARL_TEXT_PEARL_IDS`
  (ids separados por coma ⇒ sms).
- **Postgres (Neon)**: en Vercel → **Storage → Create Database → Neon
  (Postgres)** → conectar al proyecto. Vercel inyecta `DATABASE_URL` sola y el
  Brain migra a Postgres en el próximo deploy (prioridad: Postgres > Blob >
  archivo JSON). El esquema se crea solo al primer uso; tablas: `contacts`,
  `interactions`, `signals`, `nlpearl_pearls`, `nlpearl_activity` (raw).

## Autenticación de la consola

Toda la plataforma exige sesión: sin login, cualquier URL de la consola cae en
`/login` y **toda** la API responde 401 (guard global deny-by-default; solo
son públicos los webhooks de proveedores y `/precall`, que llevan su propia
verificación).

- **Registro / login**: teléfono E.164 + contraseña (scrypt) y **OTP de 6
  dígitos por WhatsApp** como segundo factor (vía el canal Gupshup propio).
- **Hardening**: OTP hasheado con vencimiento (5 min), 5 intentos y un solo
  uso; cooldown de reenvío (60 s); bloqueo de cuenta 15 min tras 5
  contraseñas fallidas; mensajes de error genéricos (sin enumeración de
  usuarios); sesión JWT en cookie httpOnly + Secure + SameSite=Lax (12 h).
- **Variables**: `AUTH_JWT_SECRET` (obligatoria en prod — ya cargada en
  Vercel), `AUTH_SESSION_HOURS`, `AUTH_OTP_TTL_MIN`.
- En `MOCK=true` (desarrollo) el OTP se imprime en el log del server en vez
  de enviarse por WhatsApp.
- Usuarios en Postgres (tabla `users`); sin `DATABASE_URL` caen a un archivo
  local solo apto para desarrollo.

## Decisiones / notas

- Puertos como injection tokens (`VoiceEnginePort`, `ChannelPort`,
  `BrainRepository`): el binding mock/real vive en cada módulo adaptador según
  `MOCK`; el Brain nunca importa clientes concretos.
- El mock ejercita los endpoints HTTP reales del gateway (self-HTTP a
  `/precall` y `/webhooks/nlpearl`, con firma HMAC si hay secreto), no atajos
  internos.
- Persistencia: memoria + respaldo JSON detrás de `BrainRepository`
  (cambiable a SQLite/Postgres vía provider).
- No se usan los canales de texto de NL Pearl: WhatsApp/SMS son adaptadores
  propios (stubs con log).
