import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Guard de TODA la app: sin sesión válida (cookie verificada contra
 * /api/auth/me) cualquier URL redirige a /login. La protección real de los
 * datos está en el AuthGuard del backend; esto evita además que el shell de
 * la consola se muestre sin sesión.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return (await auth.ensureSession()) ? true : router.parseUrl('/login');
};
