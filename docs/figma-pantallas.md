# Hive · las 12 pantallas, al detalle

Referencia de implementación tomada de los mockups del 5 nov 2026. Existe
porque «hacelo igual al Figma» no se puede verificar de memoria: acá queda qué
lleva cada pantalla, y cada una se marca cuando está hecha de verdad.

Estado: ✅ hecho · 🟡 parcial · ⬜ sin empezar

---

## Lenguaje común (ya implementado)

- Lienzo `#eef2f6`, tarjetas blancas, radio 18–20 px, sombra de dos capas.
- Riel izquierdo: pastillas blancas de 52 px flotando; la activa en naranja
  lleno. Abajo: engranaje naranja hueco y FAB naranja «+».
- Cabecera: píldora de línea, Soporte, lupa redonda · chip de Movi con orbe,
  campana, nombre + avatar oscuro.
- Píldora OSCURA = estado activo (tabs, filtros, pasos).
- Tipografía Inter. Números tabulares en cifras.

---

## 1. La colmena 🟡

Hecho: cabecera con marca, estado de piezas, 4 KPIs con chispa, mapa con pie
de tres columnas, frase en palabras, Movi en el riel, «Qué exige atención».

Falta:
- **Carga por hora**: tarjeta ANCHA abajo, con chips «Pico 52 a las 10» y
  «Banda gris: rango normal», curva suave con punto en el pico y eje de horas
  (6 am · 8 · 10 · 12 · 2 pm · 4 · 5 pm).
- Quitar la columna del medio (Resultado neto / Tiempos / Sin respuesta): en
  el diseño el mapa ocupa ese ancho. **Decisión pendiente de Jorge.**
- Segmentado «Todos · WhatsApp · Voz · SMS» arriba a la derecha, no chips.
- La píldora de estado incluye «⚠ Mapa · 1 fallo» en rojo cuando algo falla.

## 2. Conversaciones ⬜

Tres columnas: lista · chat · riel «Movi está atendiendo».

- Encabezado: «12 abiertas · 3 esperan respuesta · 1 llamada en curso».
- Lista: buscador, agrupada por HOY / AYER, cada fila con avatar de iniciales,
  nombre, resumen, hora con ícono de canal y globo de no leídos.
- Chat: nombre, teléfono · colonia · canal, chips `AMDC-4417` y `En vivo`;
  línea de «9 afirmaciones · 7 confirmadas · 1 sin respaldo · 1 falló»;
  tabs oscuros **Chat / Flujo / Caso / Dicho y hecho**.
- Burbuja de traspaso: ícono agente → agente, «Movi pasó el caso a Obras 100»,
  chip `Automático`, la frase entre comillas y acciones **Deshacer · Por qué ·
  Ver regla**.
- Reproductor de llamada: barra oscura con onda y duración.
- Riel: nebulosa grande, «Movi está atendiendo», «escribiendo a Marlon…»,
  chips `94 % seguro` y `Regla «Baches → Obras»`; tarjeta del agente con
  **Tomar el caso** (naranja) y **Cambiar**; «CONTEXTO DEL CASO» con chip
  `Se llena sola` y filas tema/colonia/referencia/reporte/espera; «LO QUE HIZO
  MOVI» con tildes y horas; «ESTADO EMOCIONAL» con barra.

## 3. Agentes ⬜ — **CONFLICTO, ver abajo**

Grilla de tarjetas (NO el panal de hexágonos):

- Encabezado «6 agentes · 1 atendiendo ahora · 4 configurados · 1 borrador»,
  buscador y segmentado Todos / Atendiendo / Configurados / Borradores.
- Tarjeta: ícono redondo, nombre, descripción, chip de estado; cifra grande de
  conversaciones con barras diminutas; **dona de «Palabra cumplida»** con su
  porcentaje; «N fases · N s de respuesta»; chips de canal; botón «Abrir ›».
- La que atiende lleva borde naranja y chip oscuro «● Atendiendo».
- El borrador va con borde punteado y barra de pasos «2 de 4 listos».
- Riel derecho: detalle con tabs Detalle / Base de conocimiento / Dicho y
  hecho, tabla de datos, «RESPALDO DOCUMENTAL» con barra, «ÚLTIMA ACTIVIDAD»
  con puntos de color, y botones «Abrir el flujo» / «Conversaciones».

## 4. Actividad ⬜

- 4 KPIs: eventos hoy, fallos (con %), tiempo promedio, en cola de reintento.
- Filtros: Todos / CRM AMDC / WhatsApp / Telefonía / Mapa + interruptor
  «Solo fallos».
- Tabla: HORA · ORIGEN (con ícono) · QUÉ SE INTENTÓ · RESULTADO (píldora verde
  «Éxito · 340 ms», gris «Falló · tiempo agotado», ámbar «Sin registro») ·
  CASO. Fila de fallo con fondo tenue. Paginación «8 de 1.284 eventos».
- Riel: «Eventos por hora» en barras con la hora pico en naranja y tooltip
  oscuro; fila de globos rojos con fallos por hora; «Dónde fallan» con barras
  horizontales por integración.

## 5. Crear agente ⬜

Tres caminos, y el **recomendado es «Con documentos»** (hoy el recomendado es
el guiado — hay que cambiarlo):

- Con documentos · `≈ 2 minutos` · «Subí el reglamento, el manual o el
  tarifario. Movi los lee y arma el agente solo, citando de qué página salió
  cada cosa.» Botón naranja «Empezar con documentos ›».
- Con flujo, conversando · `≈ 5 minutos`.
- Con formulario · `≈ 15 minutos`.
- Abajo, píldora: «¿Ya tenés uno parecido? Duplicar **Aseo 100** y ajustar ›».
- Los 4 pasos van arriba al centro, no a la derecha.

## 6. Con documentos ⬜

Tres columnas:

- **Documentos**: lista con estado por archivo (Listo / Leyendo con barra /
  Subiendo / **Con problema** con botón «Reconocer texto»), y zona de soltar
  punteada.
- **Visor**: nombre, «Página 12 de 32 · 3 pasajes subrayados», chips de lo que
  Movi subrayó (Fase / Respuesta / Regla), el texto del documento con los
  pasajes numerados en tarjetas, y paginador.
- **Lo que Movi entendió**: barra «Leyendo 73 de 91 páginas», tabs «En esta
  página · 3» / «Todo el documento · 15», lista numerada con chip de tipo y
  página, aviso ámbar «2 cosas no quedaron claras», botón «Crear el agente ›».

## 7. Canales (paso 3) 🟡

Hecho: estructura de dos columnas, WhatsApp, horario, fuera de horario.

Falta: interruptores naranjas por canal con su chip de verificación
(«Verificado por Meta», «Prueba de llamada OK»), sub-campos en tarjetas
(primer mensaje, adjuntos, plantilla), **Voz** y **SMS** como filas reales,
horario por DÍA con círculos L-M-X-J-V-S-D, bloque «Si Movi no puede» con sus
tres casos, y el riel «Así lo verá el ciudadano» con el chat de muestra.

## 8. Revisar y activar 🟡

Hecho: bloques, cifras, flujo, simulador, activar.

Falta: chip «1 cosa por resolver», estados `✓ Listo` / `⚠ 1 duda` por bloque,
aviso con botón «Completar», la línea explicativa del flujo, filas «QUÉ PUEDE
HACER» y «REGLAS QUE RESPETA» con chips, y la cita de respaldo.

## 9. Crear con flujo 🟡

Falta: tarjetas con chip de acción (Escuchar y preguntar / Decidir /
Responder) y **cita del documento con página** al pie de cada fase; «Movi está
escribiendo la siguiente fase…» como tarjeta punteada; control de zoom;
toggle Diagrama / Lista; en el chat, barra de progreso «Paso 2 de 5 · Fases»,
tarjeta del documento leído, lista de confirmaciones y **botones de respuesta
rápida**.

## 10. Editor de flujo 🟡

Falta: chip «Borrador · guardado hace 2 min», botones Probar / Publicar;
tarjetas con chip de acción y cita de página; barra flotante de herramientas;
panel derecho con nombre, **QUÉ PUEDE HACER** (Decidir/Preguntar/Ejecutar/
Responder), descripción, **SALIDAS** con destino, y la cita «Sacada de
Reglamento de Aseo · p. 9» con «Ver fragmento completo».

## 11. Cambio de agente ⬜ — pantalla NUEVA

- Tres modos: Automático (recomendado) / Preguntar primero / Nunca.
- Deslizador de confianza 70–100 % con la regla «por debajo pregunta; por
  debajo de 70 % no cambia».
- «Reglas por tema»: tema → agente destino, con cuenta de cambios del mes e
  interruptor.
- Riel: «Así lo ve el ciudadano» con la burbuja de traspaso, editor del mensaje
  con variables `{agente}` `{tema}` `{ciudadano}`, cifras del mes, y «QUIÉN
  PUEDE TOCAR ESTO» por rol.
- **Variante por plan**: en Básico todo viene fijo y en gris, con aviso naranja
  «Pasar a Institucional». Implica **planes y roles**, que no existen todavía.

## 12. Hablar con Movi ⬜ — pantalla NUEVA

- Nebulosa gigante centrada, «¿En qué puedo ayudarte, Kenia?».
- Caja de pregunta con Adjuntar / Buscar en casos / Voz.
- Sugerencias como píldoras de colores.
- Tarjeta flotante oscura «Poné a Movi a trabajar» con 4 tareas.
- Tarjeta «Tus agentes» abajo a la izquierda con estado de cada uno.
- Arriba: Historial · Nueva conversación.

---

## Lo que el diseño asume y el sistema todavía no tiene

Esto no es maquetado: es funcionalidad que hay que construir para que las
pantallas no sean una mentira bonita.

1. **Citas con página.** Media interfaz muestra «Reglamento de Aseo · p. 9».
   Hoy el documento se manda entero al proveedor y no se guarda de qué página
   salió cada cosa. Hace falta trocear por página y conservar la referencia.
2. **Dicho y hecho.** Tabs y cifras de «9 afirmaciones · 7 confirmadas · 1 sin
   respaldo». Implica contrastar lo que el agente afirmó contra la base.
3. **Cambio de agente entre agentes.** Reglas por tema, umbral de confianza y
   traspaso visible en el chat.
4. **Planes y roles.** Administradora / Supervisora / Operadora, y Básico vs
   Institucional con campos bloqueados.
5. **Palabra cumplida.** La dona que aparece en cada tarjeta de agente.
6. **Reintentos en cola.** «6 en cola de reintento» y «Reintentar fallos».

---

## Conflicto pendiente de decisión

**Agentes: ¿panal o tarjetas?**

El 2 de noviembre la instrucción fue conservar el panal de hexágonos («no se
quería cambiar la interfaz de hexágono que ya teníamos»). El mockup del 5 de
noviembre muestra una grilla de TARJETAS con donas de «Palabra cumplida».

Son incompatibles y hay que elegir una. El panal está hecho y funciona; las
tarjetas muestran más dato por agente (dona, barras, canales, estado) y es lo
que está dibujado.

Hasta que se decida, la pantalla queda como está.
