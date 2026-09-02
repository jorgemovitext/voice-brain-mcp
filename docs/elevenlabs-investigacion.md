# ElevenLabs Agents — qué nos permite hacer

Investigación previa a escribir código, hecha sobre la documentación oficial
(marzo 2026). El objetivo no es "conocer la API": es contestar, una por una,
las limitaciones que nos frenaron con NL Pearl y que están en
`docs/informe-nlpearl.md`.

La pregunta de fondo es siempre la misma: **¿podemos usar su agente sobre
NUESTROS canales, o nos ata a los suyos?**

---

## La respuesta corta

Sí. El cambio de fondo es que con NL Pearl éramos el lado de ABAJO —ellos
tenían el número, ellos conversaban, nosotros espejábamos lo que ya había
pasado—; acá somos el lado de ARRIBA: nosotros abrimos la conexión, nosotros
mandamos el audio, nosotros recibimos el audio, nosotros cortamos.

Eso invierte casi todas las limitaciones del informe.

---

## Limitación por limitación

| Queríamos | NL Pearl | ElevenLabs |
|---|---|---|
| Usar su agente sobre nuestros canales | 🔴 Atado a su canal y número | 🟢 WebSocket con audio crudo de ida y vuelta |
| Tomar la conversación en vivo | 🔴 Sin API (15 rutas → 404) | 🟢 `enable_human_takeover` + `send_human_message` |
| Ver imágenes / audios del ciudadano | 🔴 Turnos vacíos, sin URL | 🟢 `MultimodalMessage` (texto + hasta 5 archivos) |
| Recibir la conversación mensaje a mensaje | 🔴 Solo avances del flujo | 🟢 WebSocket de monitoreo con transcripción en vivo |
| Inyectar contexto | 🟡 Solo al inicio (PreCallAPI) | 🟢 Al inicio Y **en vivo**, sin interrumpir |
| Un solo hilo con el ciudadano | 🔴 Dos números → dos chats | 🟢 El canal es nuestro; no hay segundo número |
| Listar conversaciones | 🔴 `/Calls` devolvía 0 | 🟡 Sin endpoint de "activas", pero **ya no hace falta** (ver abajo) |

---

## Lo que sí está documentado

### 1. Audio crudo, en los dos sentidos

`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...`

- **Le mandamos audio**: evento `user_audio_chunk` con el audio en base64.
- **Nos devuelve audio**: evento `audio` con `audio_base_64`, y de yapa
  `alignment` (tiempos por carácter, sirve para subtitular).
- **Formatos**: `pcm_8000` … `pcm_48000` y `ulaw_8000`.

`ulaw_8000` es el formato de telefonía y `pcm_16000` el que sale de una nota
de voz de WhatsApp: los dos casos que nos interesan están cubiertos.

### 2. Modo texto puro

`conversation_config_override.conversation.text_only: true` — "si está
activado, el audio no se procesa y solo se usa texto".

Importa porque WhatsApp es mayormente texto: no hay que inventar audio para
usar el agente por chat. Mismo agente, mismo hilo, los dos medios.

### 3. Takeover humano de verdad

Endpoint aparte, de monitoreo:
`wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor`

Comandos que acepta:

| Comando | Qué hace |
|---|---|
| `enable_human_takeover` | El agente se calla; toma el humano |
| `send_human_message` | El operador escribe y sale a nombre del hilo |
| `disable_human_takeover` | Se lo devuelve al agente |
| `contextual_update` | Le mete contexto al agente sin interrumpirlo |
| `transfer_to_number` | Transfiere a un teléfono / SIP |
| `end_call` | Corta |

Esto es exactamente el botón "Tomar" que no pudimos construir con NL Pearl.
Requiere API key con scope de escritura y acceso EDITOR.

### 4. Nuestros propios números (SIP trunking)

No obliga a Twilio: acepta cualquier proveedor SIP estándar (Vonage,
Telnyx, RingCentral, Infobip, Plivo…). Requisitos: TLS 1.2+ y códecs G711
8kHz o G722 16kHz.

O sea que el número de la Línea 100 puede seguir siendo el de la AMDC.

### 5. Contexto, antes y durante

- **Al conectar**: `dynamic_variables` (clave-valor) y override del prompt,
  del primer mensaje, del idioma y hasta del LLM.
- **En vivo**: `contextual_update`, que inyecta contexto "sin interrumpir la
  conversación". Acepta un `context_id` para reemplazar un update anterior.

Con NL Pearl esto era PreCallAPI y solo al inicio. Poder corregir al agente
a mitad de conversación —"este ciudadano ya reportó esto ayer"— es nuevo.

### 6. Cierre

`post_call_transcription` (transcripción completa + análisis + metadata) y
`post_call_audio` (el audio entero en base64). Ya no dependeríamos de un
aviso que llega una sola vez y sin reintentos: el audio también nos llega.

---

## Lo que NO está documentado, y hay que probar

Esto no es pesimismo: es la lista de lo que **no** voy a dar por bueno hasta
verlo funcionando, porque es justo la clase de supuesto que nos costó rondas
con NL Pearl.

1. **El takeover en llamadas de VOZ.** La documentación describe
   `send_human_message` para conversaciones de *chat*. Que el operador pueda
   meterse en una llamada de voz en curso —y qué se oye del otro lado— hay
   que confirmarlo con una llamada real.

2. **No hay endpoint para listar conversaciones activas.** Con NL Pearl esto
   era fatal porque las conversaciones nacían del lado de ellos. Acá no:
   **nosotros abrimos la conexión, así que el `conversation_id` es nuestro
   desde el segundo cero** y lo guardamos en el Brain. Deja de ser un
   problema, pero conviene tenerlo escrito.

3. **Latencia real del ida y vuelta** por WhatsApp: nota de voz → nuestro
   backend → ElevenLabs → respuesta → nota de voz. Sobre papel funciona; el
   número hay que medirlo.

4. **Costo por minuto y límites de concurrencia** del plan. No lo miré todavía
   y define si esto es viable para el volumen de la Línea 100.

---

## Cómo encajaría en lo que ya tenemos

El Brain no cambia de forma: sigue siendo el dueño del contexto y del hilo.
ElevenLabs entra como **motor**, no como dueño del canal — que es la
diferencia con NL Pearl.

```
Ciudadano
   ↓ (WhatsApp por Gupshup · el número es NUESTRO)
whatsapp-inbound.service
   ↓  texto → UserMessage      audio → user_audio_chunk
ElevenLabsAgentService  ⇄  wss://…/convai/conversation
   ↓  respuesta (texto o audio)
Gupshup → ciudadano

   ⇅  en paralelo
wss://…/monitor  →  transcripción en vivo → consola
                 ←  enable_human_takeover (botón "Tomar")
```

Piezas que ya tenemos y sirven igual: el Brain y su contexto unificado, el
canal de Gupshup con media entrante, la consola con su chat y su botón de
tomar, la bitácora, y `AtencionService` para saber quién atiende.

---

## Fuentes

- [WebSocket de agentes](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
- [Monitoreo en tiempo real](https://elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring)
- [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)
- [Modo chat](https://elevenlabs.io/docs/eleven-agents/guides/chat-mode)
- [Autenticación y signed URLs](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
- [Variables dinámicas](https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables)
- [Webhooks de post-llamada](https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks)
