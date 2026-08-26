# Plantilla de saludo para WhatsApp (Gupshup)

## Para qué es

El ciudadano le escribe al número de NL Pearl (`+504 8886-2775`), no al
nuestro. WhatsApp solo permite mandar texto libre dentro de la ventana de 24 h
que abre un mensaje entrante, y esa ventana **nunca se abre con nuestro
número**. La plantilla es lo único que puede iniciar la conversación, porque
Meta ya aprobó el texto de antemano.

Cuando el operador responde desde la consola y el proveedor rechaza el envío
por ventana cerrada, el gateway manda esta plantilla automáticamente
(`FollowupService.abrirConPlantilla`).

## La plantilla registrada

**Nombre:** `hive_saludo2`
**Idioma:** Español (`es`)
**Categoría:** Utility (es seguimiento de un reporte que el ciudadano ya
inició — no es marketing; registrarla como Marketing complica la aprobación y
habilita el bloqueo por preferencias de publicidad).

| Variable | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre de quien atiende en la consola | `Jorge Murcia` |

**Una sola variable.** Gupshup RECHAZA el envío si la cantidad de `params` no
calza con la plantilla aprobada — no los ignora. La app manda exactamente uno
(`EjecutarService.saludar` y `FollowupService.abrirConPlantilla`), así que al
cambiar de plantilla hay que confirmar que la nueva también tenga una sola.

> Historial: la primera, `hive_saludo`, nunca llegó a aprobarse. `hive_saludo2`
> es la que quedó aprobada y en uso.

## Por qué está redactado así

- **Dice quién escribe, con nombre y apellido.** "Le escribe Jorge Murcia" es
  una persona; "Le informamos que su caso fue asignado" es un sistema. Ese es
  el punto entero de la plantilla.
- **"Estoy revisando personalmente"** deja claro que alguien lo miró de
  verdad, no que un proceso lo movió de estado.
- **Nombra el reporte que el ciudadano hizo**, así ubica el contexto sin
  repetirle los datos que ya dio.
- **Cierra con una pregunta.** No es cortesía: la respuesta del ciudadano es
  lo que abre la ventana de 24 h y habilita el texto libre. Una plantilla que
  termina en punto deja la conversación tan cerrada como estaba.
- **Trata de usted.** El agente de la Línea 100 ya usa usted con los
  ciudadanos; el operador no debería sonar distinto.

## Después de aprobarla

Gupshup le asigna un **ID** (un UUID). Va ese ID, NO el nombre: el envío
manda `template={"id": "<uuid>", "params": [...]}`, y con el NOMBRE ahí
Gupshup rechaza el mensaje.

```
GUPSHUP_TEMPLATE_SALUDO=<uuid-que-asigna-gupshup>
```

El número emisor va en `GUPSHUP_SOURCE_NUMBER` y da igual con `+` o sin él:
el adaptador le quita el prefijo antes de mandarlo.

Sin esa variable el respaldo no se activa: el envío falla con el motivo del
proveedor tal cual, que es preferible a fingir que salió.
