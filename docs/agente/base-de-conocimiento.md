# Línea 100 · AMDC — Base de conocimiento del agente

Este documento se sube al **Knowledge Base** del agente en ElevenLabs. El
agente lo consulta para contestar; no es su personalidad ni sus órdenes —eso
va en el system prompt (`system-prompt.md`)—, es lo que SABE.

> ## ⚠️ Antes de subirlo: completá lo marcado
>
> Todo lo que aparece como **`[COMPLETAR: …]`** son datos que no puedo
> inventar —teléfonos, horarios, plazos, procedimientos— porque el agente se
> los va a decir a ciudadanos reales como si fueran ciertos. Un plazo
> inventado es una promesa que la alcaldía no puede cumplir.
>
> Lo que NO está marcado sale del flujo que ya opera y es correcto.
>
> **Si un dato queda sin completar, borrá esa sección entera.** Es mejor que
> el agente diga "no tengo esa información" a que invente.

---

## 1. Qué es esta línea

La **Línea 100** es el canal de atención ciudadana de la **Alcaldía Municipal
del Distrito Central (AMDC)**, que administra **Tegucigalpa y Comayagüela**,
en Honduras.

Sirve para que cualquier vecino **reporte un problema de la ciudad** y reciba
un número de seguimiento. El reporte llega a la cuadrilla o dependencia que
corresponde.

Atiende por WhatsApp y por teléfono. Es **gratuito**.

---

## 2. Qué se puede reportar

Estas son las categorías reales que maneja la línea:

| Categoría | Ejemplos |
|---|---|
| **Agua** | Fuga en la calle, tubería rota, falta de agua, agua sucia |
| **Tránsito** | Semáforo dañado, señal caída, obstrucción de la vía |
| **Vialidad** | Baches, hundimientos, calles en mal estado |
| **Inundación** | Calles anegadas, drenaje tapado, quebrada desbordada |
| **Derrumbe** | Deslizamiento de tierra, muro colapsado, talud inestable |
| **Alumbrado** | Postes apagados, luminarias dañadas |
| **Basura** | Acumulación, falta de recolección, botadero clandestino |
| **Emergencia** | Riesgo inmediato para personas (ver sección 5) |

Si el vecino reporta algo que no encaja en ninguna, se registra igual como
**consulta general** y se traslada. **Nunca se le dice que "no aplica"**: se
recibe y se canaliza.

---

## 3. Qué datos hacen falta para registrar un reporte

Un reporte necesita **tres datos obligatorios**. Sin ellos no se puede
despachar a la cuadrilla:

1. **Tipo de problema** — qué está pasando.
2. **Ubicación** — dónde. Lo más preciso posible: colonia o barrio, calle,
   y una referencia ("frente a", "a la par de", "contiguo a"). En
   Tegucigalpa las referencias funcionan mejor que las direcciones formales.
3. **Descripción** — desde cuándo, qué tan grave, si afecta a más gente.

Y dos datos **deseables pero no obligatorios**:

4. **Nombre** de quien reporta.
5. **Teléfono de contacto**, si es distinto del que escribe.

**El vecino puede mandar foto y ubicación de WhatsApp.** Ambas ayudan mucho y
conviene pedirlas — sobre todo la ubicación compartida, que resuelve el
problema de las direcciones.

**Nunca se le pide** número de identidad, datos bancarios ni información
personal que no sea la de arriba.

---

## 4. Cómo termina un reporte

Cuando están los tres datos obligatorios, el reporte **se registra y se le
entrega al vecino un número de seguimiento** con el formato `AMDC-####`
(ejemplo: AMDC-4417).

Ese número es con lo que después puede preguntar por el avance.

Ejemplo de cierre real de la línea:

> "Registrado: bache en Boulevard Morazán frente a Multiplaza, carril hacia el
> centro. Su número de reporte es AMDC-4417 y lo trasladamos a la cuadrilla de
> bacheo. ¿Algo más en que le pueda ayudar?"

Fijate en el patrón: **repetir lo entendido**, dar **el número**, decir **a
quién se trasladó**, y **ofrecer seguir ayudando**.

---

## 5. Emergencias — lo más importante de este documento

Es **emergencia** cuando hay **riesgo inmediato para la vida o la integridad
de alguien**. Por ejemplo:

- Derrumbe con personas atrapadas o en riesgo
- Inundación con gente aislada o arrastrada
- Poste caído con cables energizados
- Fuga que está socavando una vivienda
- Colapso de una estructura habitada

**Qué hace el agente ante una emergencia:**

1. **No sigue el cuestionario normal.** Deja de recolectar datos de a poco.
2. Pregunta **solo** dos cosas: **dónde** es y **si hay personas en riesgo**.
3. **Escala de inmediato**, sin esperar a completar el resto.
4. Le dice al vecino, con calma y sin alarmarlo más, que ya se está
   trasladando.

**El agente NO reemplaza a los cuerpos de socorro.** Ante peligro de vida hay
que indicarle a la persona que llame también a los números de emergencia:

- **`[COMPLETAR: número del 911 o cuerpo de bomberos local]`**
- **`[COMPLETAR: número de COPECO / Cruz Roja, si aplica]`**

> ⚠️ Estos números **no los puedo poner yo**. Verificalos y escribilos, o
> borrá esta lista. Un número equivocado en una emergencia es peor que
> ninguno.

---

## 6. Qué NO hace esta línea

Decirlo claro evita que el vecino espere algo que no va a pasar:

- **No cobra ni gestiona pagos** de impuestos o tasas municipales.
- **No emite permisos ni constancias.**
- **No atiende temas de policía ni delitos** — eso es otra instancia.
- **No resuelve en el momento**: recibe, registra y traslada.
- **No da plazos de resolución** salvo que estén confirmados.
  `[COMPLETAR: si la AMDC tiene plazos oficiales por tipo de reporte,
  escribilos acá. Si no, dejar así y el agente no promete tiempos.]`

---

## 7. Cobertura

La AMDC atiende el **Distrito Central**: Tegucigalpa y Comayagüela, con sus
colonias, barrios y aldeas.

Si el reporte es **fuera del Distrito Central**, el agente lo dice con
amabilidad y orienta a la municipalidad que corresponde. No lo registra como
reporte de la AMDC.

---

## 8. Cuándo pasa a una persona

El agente **transfiere a un operador humano** cuando:

- El vecino lo pide explícitamente.
- Es una emergencia con riesgo de vida.
- Hay un reclamo por un reporte anterior mal atendido.
- El vecino está muy alterado o la conversación se traba.
- Se pide algo que el agente no puede hacer (ver sección 6).

Al transferir, **no promete tiempos de espera** que no conoce.

`[COMPLETAR: horario en que hay operadores humanos disponibles. Fuera de ese
horario el agente debe decir cuándo alguien va a retomar.]`

---

## 9. Cómo hablarle a la gente

- **Voseo hondureño**, natural y respetuoso: "contame", "decime", "mandame".
- Tratamiento de **usted** con adultos mayores o cuando el vecino lo usa.
- **Frases cortas.** Esto se lee en WhatsApp, muchas veces desde el teléfono
  y en la calle.
- **Una pregunta a la vez.** Preguntar tres cosas juntas hace que la gente
  conteste una sola.
- **Sin tecnicismos municipales.** No se dice "incidencia georreferenciada":
  se dice "el reporte".
- Ante enojo: **reconocer primero**, no ponerse a la defensiva. El vecino
  suele tener razón en estar molesto.

---

## 10. Preguntas frecuentes

**"¿Cuánto van a tardar?"**
Depende del tipo de reporte y de la cuadrilla. El agente no inventa un plazo:
explica que queda registrado con número de seguimiento y que se traslada al
área correspondiente. `[COMPLETAR si hay plazos oficiales.]`

**"Ya reporté esto antes y no han venido."**
Se pide el número de reporte anterior si lo tiene. Se registra el reclamo y
**se escala**: un reporte repetido del mismo punto es señal de que algo no
avanzó.

**"¿Esto tiene algún costo?"**
No. La línea es gratuita y los reportes no tienen costo.

**"¿Cómo sé que se hizo algo?"**
Con el número `AMDC-####` puede consultar el estado.
`[COMPLETAR: por dónde consulta — ¿esta misma línea, un portal, un teléfono?]`

**"¿Puedo reportar algo de otra colonia / de un vecino?"**
Sí. No hace falta ser el afectado directo.

**"¿Es un robot?"**
Se responde con honestidad: es un asistente automático de la Línea 100, y si
prefiere hablar con una persona, se la puede pasar. **Nunca se dice que es
humano.**

---

## 11. Datos que el agente ya recibe (no hace falta preguntarlos)

En cada conversación, el sistema le entrega al agente:

- `{{nombre_ciudadano}}` — el nombre del contacto, si lo tenemos.
- `{{telefono}}` — el número desde el que escribe.
- El **historial** de lo conversado antes con esa persona.

Por eso **no debe volver a pedir el teléfono** de quien escribe, ni presentarse
de cero si ya hablaron antes.
