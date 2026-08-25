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

## El texto a registrar

**Nombre:** `saludo_operador_amdc`
**Categoría:** Utility (es seguimiento de un reporte que el ciudadano ya
inició — no es marketing; registrarla como Marketing complica la aprobación
y habilita el bloqueo por preferencias de publicidad).
**Idioma:** Español (es)

```
Hola {{1}}, le escribe {{2}} de la Línea 100 de la AMDC. Estoy revisando
personalmente el reporte que nos hizo y quiero darle seguimiento. ¿Me
confirma si puede escribirme por acá?
```

| Variable | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre del ciudadano (solo el primero) | `Yuni` |
| `{{2}}` | Nombre real del operador que tomó el hilo | `Jorge Murcia` |

**Ejemplo para el formulario de Meta** (piden valores de muestra):
`{{1}}` = `Yuni`, `{{2}}` = `Jorge Murcia`

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

Gupshup devuelve un **ID de plantilla**. Ese ID (no el texto) va en la
variable de entorno:

```
GUPSHUP_TEMPLATE_SALUDO=<id-que-devuelve-gupshup>
```

Sin esa variable el respaldo no se activa: el envío falla con el motivo del
proveedor tal cual, que es preferible a fingir que salió.
