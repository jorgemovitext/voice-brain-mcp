import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Ante un 401 de cualquier endpoint protegido (sesión vencida o revocada),
 * limpia el estado y manda a /login. Los endpoints de /api/auth se excluyen:
 * sus 401 son parte del flujo (p. ej. credenciales inválidas).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((err) => {
      const esAuthEndpoint = req.url.includes('/api/auth/');
      if (err instanceof HttpErrorResponse && err.status === 401 && !esAuthEndpoint) {
        auth.sessionExpired();
        if (!router.url.startsWith('/login')) void router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};
