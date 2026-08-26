import { Resource } from '@angular/core';

/**
 * El valor de un recurso, o undefined — sin lanzar.
 *
 * En Angular 22, leer `.value()` de un `httpResource` que está en estado de
 * error LANZA (`ResourceValueError`). Como toda la consola vive de sondeos,
 * un solo poll fallido —un microcorte de red, un 500 transitorio, la lambda
 * arrancando en frío— hacía lanzar en cadena a todos los computeds y effects
 * que leían ese recurso, hasta el siguiente sondeo exitoso. En la consola del
 * navegador se veía como ráfagas de `ResourceValueError` sin ninguna acción
 * del usuario.
 *
 * `hasValue()` es la lectura segura: false en error, true (con el valor
 * anterior retenido) durante un reload. Todos los `X.value()` de componentes
 * pasan por acá; el estado de error se sigue consultando aparte con
 * `X.error()`, que no lanza.
 */
export function valorDe<T>(res: Resource<T>): T | undefined {
  return res.hasValue() ? res.value() : undefined;
}
