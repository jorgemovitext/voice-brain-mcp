/**
 * Comparación de teléfonos entre canales.
 *
 * El mismo número llega escrito distinto según quién lo mande: NL Pearl
 * entrega `50494882705`, Gupshup `+50494882705`, y una carga a mano puede
 * traer `+504 9488-2705`. Los repositorios comparaban con igualdad exacta de
 * string, así que el mismo ciudadano terminaba como DOS contactos y su
 * conversación se partía en dos hilos — o directamente "desaparecía", porque
 * los mensajes nuevos caían en el contacto que no estabas mirando.
 *
 * El teléfono es la llave de identidad de toda la app, así que se compara por
 * sus dígitos y nada más. No se toca cómo se GUARDA: normalizar la escritura
 * cambiaría datos ya existentes sin necesidad.
 */
export function digitosDe(telefono: string | undefined | null): string {
  return (telefono ?? '').replace(/\D/g, '');
}

/** ¿Son el mismo número, aunque estén escritos distinto? */
export function mismoTelefono(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = digitosDe(a);
  return !!x && x === digitosDe(b);
}
