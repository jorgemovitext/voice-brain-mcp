# Plan: de prototipo a Hive SaaS (PYME y mid-market)

Movitext · 4 nov 2026 · Basado en el PRD v0.3 (2 nov 2026), el Figma «Hive ·
Pantallas» (versión naranja, 15 pantallas) y el estado real del código a hoy
(commit `702269b`, 243 tests).

La regla de este plan: **cada fase deja algo vendible o demostrable**. No hay
ninguna fase de "arquitectura" que no se pueda enseñar en una demo.

---

## 0. Dónde estamos parados (inventario honesto)

Lo que el prototipo YA tiene y el PRD pide:

| Pieza | Estado | Historia del PRD |
|---|---|---|
| Agente ElevenLabs por WebSocket, texto y voz | En producción | base de todo |
| WhatsApp entrante/saliente (Gupshup) | En producción, **un solo número** | HU1 (parcial) |
| Multi-agente con selector («poner a atender») | Hecho esta semana | HU2 (base) |
| Tablero y bandeja que siguen al agente activo | Hecho esta semana | — |
| Base de conocimiento por agente + subir PDF/Word/MD | Hecho | HU3, HU6 |
| Constructor de agentes conversando + editor de flujo | Hecho | HU2 (base) |
| Banco de pruebas con herramientas simuladas (`/probar`) | Hecho | **HU15 casi gratis** |
| Escalamiento a humano con aviso (HubSpot + WhatsApp) | Hecho para Línea 100 | HU8 (base) |
| OTP por WhatsApp para la consola | Hecho | HU7 (germen) |
| Revisión pre-cambio de agente (reparos) | Hecho | HU2/HU4 (germen) |
| Bitácora de webhooks en Postgres | Hecho | HU11 (germen) |

Lo que el PRD pide y **no existe**:

1. **Clientes (tenants)**: hoy hay UNA organización con varios agentes. No hay
   entidad "cliente" con su número, horario, zona horaria, contactos de
   escalamiento, plan y estado.
2. **Número propio del cliente**: todo entra por nuestro número de Gupshup.
   No hay routing «número destino → cliente → agente».
3. **Custom Channel de ElevenLabs** (HMAC): hoy hablamos por WebSocket directo.
4. **Gateway OTP de Hive** para usuarios finales (/otp/start, /verify, /status,
   /handoff) con intercepción del código en el canal.
5. **Plantillas de roles** parametrizadas (recepcionista, ventas, datos+OTP,
   seguros, Moví).
6. **Agenda** (Google Calendar / Cal.com) y **recordatorios** 24 h/2 h con SMS.
7. **Conteo por línea para facturar** + panel de costo de Meta.
8. **Suite de ataques** (dominio cerrado, inyección) repetible + escáner
   regex+Luhn de las reglas innegociables.
9. **Infra propia** (servidor, firewall, WAF, CI/CD de Byron). Hoy: Vercel.
10. **La interfaz Hive** (tema claro naranja): la consola actual es oscura y
    single-tenant.

---

## 1. Decisiones de arquitectura (las tomo yo, las valido con vos)

**D1. Tenant = «línea»** (cliente con su número de WhatsApp). Una tabla
`clientes` y `linea_id` en TODAS las tablas de datos (contactos,
interacciones, señales, bitácora, settings por cliente). La Línea 100 pasa a
ser el tenant #1 — nada se migra dos veces.

**D2. Un despliegue, muchos tenants** (no una instancia por cliente). El
aislamiento es por fila (`linea_id`) + KB separada por agente en ElevenLabs
(ya es así). Instancia-por-cliente queda para enterprise (deuda documentada
del PRD).

**D3. El transporte de WhatsApp es intercambiable.** Hoy Gupshup; el PRD exige
canal Movitext (BSP vía Concepto Móvil, pendiente de Enrique). Ya existe
`ChannelPort` — se agrega la resolución por número destino y un adaptador por
proveedor. Cuando el BSP esté, es UN adaptador nuevo, no una reescritura.

**D4. ElevenLabs sigue siendo el motor**, pero la ruta cambia por fases:
WebSocket directo (hoy, funciona) → Custom Channel firmado (cuando salga de
alpha o nos den acceso). El diseño de R&D ya lo asume; nuestro cliente actual
queda como respaldo. **Pendiente humano: preguntarle a ElevenLabs la fecha.**

**D5. Vercel hasta que Byron esté listo.** El pipeline de CI (tests + escáner
de secretos + escáner Luhn) se arma YA y apunta a Vercel; cambiar el destino
del deploy a servidor propio es el último paso, no el primero. Los topes de
Vercel (30 s, 4.5 MB) ya los conocemos y no bloquean el MVP de texto.

**D6. La UI nueva es un re-TEMA + pantallas nuevas, no un rewrite.** Angular,
signals y componentes quedan; cambian tokens (claro, naranja), el riel, y se
agregan las vistas del Figma que no existen. Las 15 pantallas del Figma mapean
~70 % a vistas que ya funcionan.

---

## 1b. Stack

Regla: **el stack ideal es el que ya corre en producción, afilado** — se
cambia una pieza solo cuando una historia del PRD lo exige, no por moda.
Angular, Tailwind y NestJS son decisión tomada; el resto se justifica acá.

### Frontend
| Pieza | Elección | Por qué |
|---|---|---|
| Framework | **Angular 22** (standalone, signals, `httpResource`, `@if/@for`) | Ya corre; los 243 tests y toda la consola viven ahí |
| Estilos | **Tailwind CSS v4** + tokens del Figma como variables CSS (`--primary`, superficies, radios) | Entra CON el re-tema de la Fase 6: cada pantalla que se re-viste nace en Tailwind y el SCSS viejo muere con la vista que reemplaza. Se acaban los topes de presupuesto de SCSS por componente |
| Componentes | Propios (panal, flujo, chat) — **sin librería UI** | El Figma es un lenguaje propio; una librería encima es pelearle a dos sistemas de diseño |
| Gráficos | SVG inline propio (como hoy: panal, flujo, mapa) | Cero dependencias, control total del estilo Hive |
| Estado | Signals + `httpResource`; nada de NgRx | El tamaño de la app no paga un store global |

### Backend
| Pieza | Elección | Por qué |
|---|---|---|
| Framework | **NestJS 11 + Fastify** | Ya corre; Fastify es requisito nuestro de siempre |
| Validación | **zod 4** en los bordes (webhooks, body de la API) | Ya es la regla del repo; obligatoria además por el SDK de MCP |
| Datos | **Postgres + SQL directo con `pg`** (sin ORM) | Las consultas finas (append atómico jsonb, ordinality) ya nos costaron aprenderlas; un ORM las esconde y no paga el peaje de migrar |
| Migraciones | `ensureSchema` idempotente (como hoy) + archivo de migraciones versionado cuando entre `linea_id` | El ALTER suelto deja de alcanzar con multi-tenant |
| Colas y cron | **Vercel Cron hoy → BullMQ + Redis en el servidor de Byron** | Recordatorios 24h/2h, reintentos de handoff y escáner diario necesitan cola de verdad; en Vercel se simula con cron + idempotencia, y la interfaz queda detrás de un puerto para que el cambio sea un adaptador |
| Auth consola | JWT en cookie httpOnly + OTP (como hoy), roles por cliente encima | Deny-by-default ya probado; solo se le suma `linea_id` al token |
| IA | **ElevenLabs Agents** (motor) + **Claude API** (constructor/copiloto Movi donde haga falta más cabeza) | Lo decidido; el cliente WebSocket propio queda de respaldo del Custom Channel |

### Plataforma
| Pieza | Elección | Por qué |
|---|---|---|
| Hosting | **Vercel hoy → Docker Compose en servidor propio (Byron)** | D5: el pipeline se arma ya; el destino cambia al final |
| Borde | **Cloudflare delante del servidor** (WAF, TLS, rate limit) + Nginx/Caddy adentro | El WAF de HU11 sin licenciar un appliance |
| CI/CD | **GitHub Actions**: tests → gitleaks (secretos) → suite de ataques → escáner Luhn → deploy | Las reglas innegociables de QA viven en el pipeline, no en un doc |
| Logs | **pino** estructurado con redacción de campos sensibles + bitácora Postgres (como hoy) | La regla «cero OTP/tarjetas en logs» necesita redacción en la librería, no disciplina |
| Monitoreo | Healthchecks + alertas por WhatsApp/correo a Pao (uptime-kuma o cron propio) | El aviso de handoff caído en 5 min lo exige QA |
| Secretos | `.env` por entorno, fuera del repo; gitleaks en CI; key de ElevenLabs rotada y cuentas dev/prod separadas | Pendiente #7, condición de piloto |
| E2E | **Playwright** contra el simulador (HU15) | Las 20 preguntas del onboarding y los 20 ataques corren como specs, repetibles |

Lo único genuinamente NUEVO del stack es: Tailwind v4, BullMQ/Redis (recién en
el servidor propio), Cloudflare, gitleaks, pino y Playwright. Todo lo demás es
lo que ya está en producción.

---

## 2. Fases

### Fase 0 · Cimiento multi-cliente (sin UI nueva)
*El SaaS empieza en el modelo de datos, no en la pantalla.*

- Tabla `clientes`: nombre, número(s), horario, zona horaria, contactos de
  escalamiento, agente(s), plan, estado (demo/piloto/activo).
- `linea_id` en contacts, interactions, signals, bitácora y settings;
  migración que asigna todo lo existente a «Línea 100».
- Routing entrante: el webhook resuelve cliente por número destino; cada
  cliente tiene su agente activo (el selector actual pasa a ser por cliente).
- Selector de línea en la consola (el chip «Línea 100» del Figma, arriba a la
  izquierda): TODO lo que ya filtra por agente pasa a filtrar por línea.
- Config por cliente en `app_settings` (`cliente:<id>:*`), env solo como piso
  (regla que ya seguimos).

**Criterio de salida**: dos clientes de prueba conviven sin verse — se
verifica con test de integración, no a ojo.

### Fase 1 · Plantillas de roles + onboarding de 2 horas (HU2, HU14, HU15)
*Lo que hace vendible el producto sin tocar código por cliente.*

- Plantillas de los 5 roles del PRD como datos (objetivo, tono, límites,
  datos que pide, acciones, regla de escalamiento) + variables {negocio,
  horario, KB, contactos}. El constructor y `duplicar()` ya hacen el 80 %.
- Flujo de alta: elegir rol(es) → llenar datos del cliente → agente creado,
  con el aviso IA de HU14 en el primer mensaje (texto editable).
- **Simulador (HU15)**: exponer el banco de pruebas actual como pantalla
  («Revisar» del Figma) con la KB real y herramientas en modo prueba (cero
  citas reales, cero SMS, cero costo Meta). Correr ahí las 20 preguntas del
  onboarding y guardar el resultado como evidencia de aprobación del cliente.
- Checklist de onboarding (sección 8 del PRD) como pantalla, no como doc.

**Criterio de salida**: cliente ficticio de clínica configurado en < 2 h
cronometradas, aprobado en el simulador.

### Fase 2 · Dominio cerrado y reglas innegociables (HU4, 6b)
*Lo que evita que Meta nos bloquee un número y QA nos pare el go-live.*

- Guardrail de dominio en TODAS las plantillas (ya existe el patrón en los
  prompts de la Línea 100).
- Suite automatizada: 20 preguntas fuera de dominio + 20 ataques de
  inyección/filtración del prompt, corriendo contra el agente real vía el
  simulador. Se ejecuta en CI **en cada cambio de prompt o de modelo** (lo
  exige QA) y falla el pipeline si un ataque pasa.
- Escáner regex+Luhn sobre historial del proveedor, logs y avisos: job diario
  + paso de CI. Cero coincidencias o no sale.
- Reglas anti-loop (≤ 12 turnos, ≤ 2 repeticiones, escala en 1 turno si piden
  persona): se implementan en el canal (contador por conversación), no se le
  pide fe al prompt.

### Fase 3 · Gateway OTP + handoff formal (HU7, HU8)
*Las dos piezas de seguridad que diferencian a Hive de Meta.*

- Endpoints `/otp/start`, `/otp/verify`, `/otp/status`, `/handoff` en la API
  (el diseño de R&D). `verify` SOLO lo llama el canal: cuando la sesión espera
  código, el canal intercepta el mensaje y a ElevenLabs le llega «verificado»
  — el código jamás entra al historial del proveedor.
- Política NIST: 6 dígitos, un solo uso, 5 min, 3 intentos → bloqueo 30 min y
  escala, 3 reenvíos/hora, verificación válida 15 min de inactividad.
- SMS por el gateway de Movitext — **necesito las credenciales/API del
  gateway SMS** (hoy el OTP de la consola sale por WhatsApp).
- Handoff: aviso al equipo del cliente (correo o WhatsApp, decisión abierta
  del PRD) con resumen sin datos sensibles, reintento a los 5 min y alerta a
  Pao. La bandeja humana completa queda para después, como dice el PRD.

### Fase 4 · Agenda y recordatorios (HU12, HU13)
- Integraciones nativas de ElevenLabs: Google Calendar y Cal.com (API key).
  Sin tools nativas de editar/borrar: `hive_calendar_cancel` propia que solo
  toca citas del propio usuario (regla de R&D).
- Recordatorios 24 h y 2 h: scheduler (cron de Vercel hoy, systemd/cron en el
  servidor de Byron después) + plantilla de utilidad de Meta fuera de
  ventana + SMS de respaldo si WhatsApp no entrega en 10 min.
- Pruebas de duplicados y de reservas simultáneas (QA: con 2 reservas al
  mismo horario, solo una se confirma).

### Fase 5 · Medir para cobrar (HU10, HU16)
- Tabla de eventos de mensajería: por línea, dirección, categoría de Meta,
  entregado/no, conversación (ventana 24 h). Los webhooks ya traen todo; hoy
  lo tiramos.
- Reporte mensual por línea: mensajes Y conversaciones en paralelo (la unidad
  está abierta en el PRD — medimos ambas desde el día uno y la decisión
  comercial no espera a desarrollo).
- Panel de costo de Meta por número (tarifa por país y fecha configurable,
  1,000 gratis contadas).

### Fase 6 · La interfaz Hive (transversal, arranca con la Fase 1)
*Del Figma «Hive · Pantallas» (naranja) a la consola.*

- **Tokens primero**: tema claro, naranja #F34700 como acento, tarjetas
  blancas, el riel izquierdo de íconos y la cabecera con selector de línea,
  búsqueda, chip de Movi y perfil. Un PR solo de tema, sin mover lógica.
- Pantallas que ya existen y se re-visten: Colmena (01), Conversaciones (02),
  Agentes (03), Crear (04), Con documentos (05), Crear con flujo (06), Editor
  de flujo (07), Actividad (08).
- Pantallas nuevas del Figma: Canales (05b), Revisar/simulador (05c), Cambio
  de agente con variante por plan (09/09b), Hablar con Movi (10).
- El panel «Movi está atendiendo» del Figma (qué hizo, % seguro, regla
  aplicada, tomar el caso) ya tiene el dato detrás (acciones, dicho-y-hecho):
  es maquetar, no construir.

### Fase 7 · Infra de Byron y go-live (HU11)
- Pipeline CI/CD: tests (243 y subiendo) + escáner de secretos + suite de
  ataques + escáner Luhn → deploy. Nada manual a producción.
- Migración Vercel → servidor propio (firewall, WAF, solo 443 + lista de
  Byron, escaneo externo que coincida con la lista).
- Postgres: seguir en Neon o mover a servidor — decisión con Byron según su
  doc de infraestructura.
- Pruebas QA completas (criterios del 2 nov) + pilotos con 20 preguntas
  reales por cliente.

---

## 3. Dependencias externas (nada de esto es código)

| # | Qué | Quién | Bloquea |
|---|---|---|---|
| 1 | Confirmar BSP / ruta Concepto Móvil para alojar números | Enrique | HU1 con número propio (mientras: Gupshup) |
| 2 | Fecha en que Custom Channel sale de alpha | preguntar a ElevenLabs | D4 (mientras: WebSocket actual) |
| 3 | API y credenciales del gateway SMS de Movitext | Byron/Finanzas | Fase 3 (OTP) y Fase 4 (SMS respaldo) |
| 4 | Documento de infraestructura (puertos, WAF, servidor) | Byron | Fase 7 |
| 5 | Medio del aviso de handoff (correo o WhatsApp) | workshop | Fase 3 (se implementa el elegido) |
| 6 | Plan de ElevenLabs: límites de concurrencia y agentes por cuenta con N clientes | Murcia revisa | escala de Fase 0 |
| 7 | **Rotar la API key de ElevenLabs** (pendiente viejo) y cuentas separadas dev/prod | Murcia | antes del primer piloto |

## 4. Riesgos que ya conocemos (y su mitigación barata)

- **Deny-by-default de ElevenLabs** (nos mordió 3 veces): toda operación que
  active un agente pasa por `poner()`, que ya deja permisos listos. Las
  plantillas nacen con todo habilitado.
- **Ventana de 24 h de Meta**: todo saliente fuera de ventana va por
  plantilla aprobada; el conteo de Fase 5 registra la categoría para cobrarlo.
- **Alucinación de precios/coberturas** (HU3): rúbrica de QA en el simulador
  + guardrail en plantilla + revisión semanal de Pao con muestra.
- **Datos clínicos**: QA recomienda NO manejarlos en el MVP. Las plantillas
  de clínica arrancan sin datos de pacientes: solo citas y preguntas
  generales. Lo escribimos en el contrato del piloto.
- **Lock-in de ElevenLabs**: el Brain, el canal, el OTP y la facturación son
  nuestros; lo que vive allá (prompts, KB, flujos) ya se administra 100 % por
  nuestra API y se puede exportar.

## 5. Qué necesito de vos para arrancar

1. Confirmar el orden de fases (o reordenar: puedo arrancar Fase 0 y Fase 6
   en paralelo si la demo manda).
2. Los ítems 1–3 de dependencias externas en movimiento (Enrique, ElevenLabs,
   gateway SMS).
3. Acceso de lectura estable al Figma (ya lo tengo por MCP) y aviso cuando
   cambie.
4. La decisión de hosting si Byron ya tiene fecha — cambia dónde apunto el
   CI/CD desde la Fase 2.
