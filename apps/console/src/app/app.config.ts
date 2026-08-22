import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor } from './auth/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // withComponentInputBinding: el :id de la ruta llega como input() al componente
    provideRouter(routes, withComponentInputBinding()),
    // authInterceptor: cualquier 401 de la API cierra sesión y manda a /login
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
