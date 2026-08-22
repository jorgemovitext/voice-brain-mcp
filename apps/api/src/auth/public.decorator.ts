import { SetMetadata } from '@nestjs/common';

/**
 * Marca un controller o handler como accesible SIN sesión. Todo lo demás
 * queda protegido por el AuthGuard global (deny-by-default).
 *
 * Solo debe usarse en: endpoints de auth, webhooks de proveedores (tienen su
 * propia verificación) y /precall (lo invoca NL Pearl).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
