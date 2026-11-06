# Plan: de Hive-producto a Hive-plataforma

Movitext · 6 nov 2026 · Continúa `plan-hive-saas.md`, que queda vigente para
las pantallas del cliente. Este documento es el otro lado: **lo que falta para
vender el servicio sin que nosotros toquemos nada a mano.**

Estado al escribirlo: commit `d6f00b1`, 378 tests en 42 suites, en producción
en `movihive.movitext.com`.

---

## 1. Qué estamos vendiendo (la frase que ordena todo)

> Un cliente contrata un **agente** que atiende a *sus* clientes por WhatsApp
> —vender, cobrar, dar soporte, tomar pedidos, agendar— y que **dispara
> acciones en el CRM que ese cliente ya usa**. Nosotros cobramos el agente
> por mes y los mensajes por unidad, con precio por país.

Tres consecuencias que no son obvias y de las que cuelga el resto del plan:

1. **El agente no sirve si no toca el sistema del cliente.** Un agente que
   conversa bien y no crea el pedido es una demo. Lo que se vende es el
   efecto en su CRM, no la conversación.
2. **El canal y el proveedor son intercambiables; el cobro no.** WhatsApp hoy,
   SMS después; Gupshup hoy, el motor de Movitext también. Lo único que no
   puede cambiar de forma es el registro de lo que se cobró.
3. **Nosotros somos un cliente más del sistema, con una llave extra.** El
   back-office no es una app aparte: es la misma, con el tipo de empresa en
   `proveedor`.

---

## 2. Lo que ya está hecho (para no reconstruirlo)

| Pieza | Estado |
|---|---|
| Agente ElevenLabs contestando WhatsApp con contexto del hilo | producción |
| Multi-agente, líneas por cliente, traspaso entre agentes | producción |
| Aislamiento por organización (contactos, conversaciones, líneas, webhook) | producción |
| Dos roles (admin/usuario) con guard que falla cerrado | producción |
| Medición por mensaje con precio **congelado** y tarifa real de Meta | producción |
| Planes, topes de gasto, seguimiento automático con cuatro frenos | producción |
| Registro de facturación con forma de CDR (cuenta, prefijo, destino, proveedor, operadores) | producción |
| Back-office: clientes, ficha por cliente, factura por país, CSV | producción (sin pantalla) |

---

## 3. Los huecos, por lo que bloquean

### 3.1 Bloquea cobrar

| Hueco | Qué pasa hoy | Qué falta |
|---|---|---|
| **Pasarela de pago** | El plan cambia y el cobro «va por factura» | PixelPay o similar (Stripe no opera directo en HN). Checkout, reintento, baja por falta de pago |
| **Factura como documento** | El consumo cuadra pero no hay nada que mandar | PDF/CSV por período cerrado. El CSV ya existe en el back-office; falta el PDF y el envío |
| **Facturación fiscal (CAI)** | No existe | Decisión contable antes que técnica |
| **El margen** | `MARGEN_POR_DEFECTO = 2.0`, puesto por mí como marcador | Confirmarlo comercialmente. Es un número en un archivo |

### 3.2 Bloquea que entre el segundo cliente

| Hueco | Qué pasa hoy | Qué falta |
|---|---|---|
| **Credenciales de WhatsApp globales** | `GUPSHUP_API_KEY` y el número salen del entorno: **todos los mensajes salen por el número de la AMDC** | Credenciales por línea, cifradas, en la base |
| **Alta de número** | Exige saber el «destino» de Gupshup, que es jerga nuestra | Alta asistida: el cliente pide, nosotros aprobamos, él ve «en proceso» |
| **Aislamiento de agentes** | `agentes_org` existe pero el listado **no filtra**: un cliente nuevo ve agentes ajenos | Cerrarlo antes de publicitar el registro |
| **Un proveedor por código** | La fábrica elige gupshup/cloud/stub del entorno | Proveedor por línea (columna ya creada) + adaptador del motor de Movitext |

### 3.3 Bloquea operar sin sustos

| Hueco | Qué pasa hoy | Qué falta |
|---|---|---|
| **`CRON_SECRET`** | Sin configurar: los seguimientos **no salen** | Dos minutos en Vercel |
| **Cadencia del cron** | Diaria (límite del plan Hobby) | Vercel Pro o programador externo cada 15 min |
| **Cambio de contraseña** | No existe pantalla | Pantalla + fallback por correo (hoy depende de la ventana de 24 h de WhatsApp) |
| **Alertas hacia nosotros** | Un mensaje sin medir es una línea de log que nadie mira | Aviso a nuestro WhatsApp/correo ante errores |
| **Back-office sin pantalla** | La API existe; se consulta con `curl` | La consola del dueño |

---

## 4. Las integraciones con el CRM del cliente

Es la pieza que convierte la conversación en trabajo hecho, y hoy es el
hueco más grande del producto.

### 4.1 El problema real

Las herramientas del agente (`registrar_reporte`, `avisar_autoridad`,
`asignar_tarea`) están **cableadas a HubSpot y al caso de la AMDC**. Para un
taller que usa otro CRM, esas herramientas no significan nada. Y cada cliente
nuevo con otro CRM, hoy, es código nuevo en el núcleo.

### 4.2 La forma que evita la deuda

Separar **lo que el agente quiere hacer** de **dónde se hace**:

```
  Herramienta del agente        Acción de negocio        Conector del cliente
  (lo que el modelo invoca)     (contrato estable)       (HubSpot, Zoho, …)

  crear_pedido            →     pedido.crear       →     POST /deals  (HubSpot)
                                                   →     POST /orders (Shopify)
                                                   →     webhook      (a medida)
```

- **La acción de negocio es el contrato**: `pedido.crear`, `cita.agendar`,
  `ticket.abrir`, `pago.registrar`, `lead.crear`, `contacto.sincronizar`.
  Son pocas y estables; es el vocabulario del producto.
- **El conector traduce** esa acción a la API del CRM de cada cliente.
- **El agente nunca conoce el CRM.** Su prompt y sus herramientas no cambian
  cuando el cliente cambia de sistema.

### 4.3 Las tres integraciones de arranque

| Conector | Por qué |
|---|---|
| **HubSpot** | Ya está escrito y en producción; se convierte en el primer conector |
| **Webhook genérico + API de Hive** | Cubre a todo cliente con un sistema propio. Es el que más clientes desbloquea por línea de código |
| **Un CRM de PYME regional** (Zoho / Bitrix24 / Pipedrive) | Depende de qué usan los primeros clientes reales — conviene elegirlo con un cliente en la mesa, no antes |

### 4.4 Reglas que se deciden ahora o se pagan después

- **Toda acción se anota en el hilo** como ya se anota el traspaso: quién la
  disparó, con qué datos, si salió bien. Sin eso, «el agente creó el pedido»
  es una afirmación sin prueba.
- **Reintento e idempotencia.** Un CRM caído no puede perder un pedido, y un
  reintento no puede crear dos. Llave de idempotencia por acción.
- **Credenciales por cliente, cifradas**, nunca en el entorno.
- **El agente no inventa datos para completar una acción.** Si falta el
  número de pedido, pregunta o escala; no rellena.

---

## 5. Whitelabel: lo que hay que hacer *ahora* para que después sea barato

No hace falta construirlo; hace falta **no cerrarse la puerta**:

1. **Marca como dato de la organización**, no constante: nombre, logo,
   color, dominio. Una tabla, aunque hoy tenga una fila.
2. **Nada de «Hive» cableado en componentes.** Hoy está en el título, el
   login y el rail. Que salga de la marca de la sesión.
3. **Dominio por cliente** (`agentes.sucliente.com`): afecta cookies y CORS.
   La decisión es de ahora; la implementación, después.
4. **Los textos del agente ya son datos** (plantillas): eso ya está bien.
5. **Correos y plantillas de WhatsApp** también por marca.

Costo de hacerlo ahora: bajo. Costo de hacerlo con 20 clientes: alto, porque
hay que migrar datos y re-aprobar plantillas en Meta.

---

## 6. Multi-canal y multi-proveedor

**Ya resuelto en el cobro**: la tarifa es por canal, y el CDR guarda canal y
proveedor. Agregar SMS no migra ninguna fila vieja.

**Falta en el envío**:

- `ChannelPort` existe y el envoltorio de medición ya envuelve lo que salga.
- El adaptador del **motor de WhatsApp de Movitext** (endpoints propios) entra
  como un `ChannelPort` más.
- La fábrica debe elegir **por línea** y no por entorno.
- El tráfico propio de WhatsApp de Movitext se modela como otro proveedor con
  su propio costo — y ahí el margen es mayor, que es justamente el motivo.

---

## 7. Bajar NL Pearl

Son ~6.000 líneas y **no se puede borrar de un tirón**: la consola todavía
usa dos endpoints que viven en ese módulo (`/api/contacts/:id/atencion` y
`/acciones/:accion`).

Orden sin romper nada:

1. Mover `atencion` y `acciones` a un módulo propio (son del producto, no de
   NL Pearl).
2. Apagar la sincronización y los webhooks de NL Pearl; dejar de escribir en
   `nlpearl_activity`.
3. Comprobar que ninguna pantalla quedó muda.
4. Borrar el módulo y sus tablas, con respaldo previo del histórico.

---

## 8. Orden propuesto

| # | Qué | Por qué primero | Tamaño |
|---|---|---|---|
| 1 | `CRON_SECRET` + aislamiento de agentes | Riesgos ya abiertos | horas |
| 2 | Pantalla del back-office | La API ya está; es lo que pediste ver | días |
| 3 | Credenciales y proveedor por línea | Habilita al segundo cliente | 1 semana |
| 4 | Acciones de negocio + conector HubSpot + webhook genérico | Es lo que se vende | 2 semanas |
| 5 | Pasarela de pago + factura descargable | Cobrar solos | 2 semanas |
| 6 | Contraseña, alertas, marca como dato | Operar sin sustos | 1 semana |
| 7 | Bajar NL Pearl | Limpieza, sin prisa | días |

---

## 9. Decisiones que no son mías

1. **El margen sobre el costo** (hoy 2.0).
2. **Precio mensual de cada plan** (hoy 49 / 149 USD, puestos por mí).
3. **Qué tercer CRM** — conviene elegirlo con el primer cliente que lo pida.
4. **Moneda de cobro**: hoy todo en USD porque Meta cobra en USD. Facturar en
   lempiras exige decidir quién asume el tipo de cambio.
5. **Qué se hace cuando un cliente no paga**: ¿el agente deja de contestar?
   Cortarle la respuesta a quien escribe tiene costo reputacional para el
   cliente y para nosotros.

---

## 10. El hueco de lógica más grande que queda

Hoy el producto sabe **contestar** y **cobrar**, pero no sabe **cerrar el
círculo**: la conversación no deja rastro en el sistema del cliente. Mientras
eso falte, lo que vendemos es un contestador con buena memoria.

Las acciones de negocio (§4) son lo que lo convierte en lo que dice el pitch.
