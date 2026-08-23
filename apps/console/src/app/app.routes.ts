import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
    title: 'Acceso · Brain',
  },
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
    title: 'La colmena · Brain',
  },
  {
    path: 'contacts',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contacts/contacts').then((m) => m.ContactsPage),
    title: 'Contactos · Brain',
  },
  {
    path: 'contacts/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    title: 'Conversación · Brain',
  },
  {
    path: 'conversations',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/conversations/conversations-index').then((m) => m.ConversationsIndexPage),
    title: 'Conversaciones · Brain',
  },
  {
    path: 'conversations/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    // withComponentInputBinding también bindea route.data → input withThreads
    data: { withThreads: true },
    title: 'Conversaciones · Brain',
  },
  {
    path: 'workers',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/workers/workers').then((m) => m.WorkersPage),
    title: 'Obreros · Brain',
  },
  {
    path: 'integrations',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/integrations/integrations').then((m) => m.IntegrationsPage),
    title: 'Integraciones · Brain',
  },
  {
    path: 'perfil',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/profile/profile').then((m) => m.ProfilePage),
    title: 'Tu cuenta · Brain',
  },
  {
    path: 'demo',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/demo/demo').then((m) => m.DemoPage),
    title: 'Demo del flujo · Brain',
  },
  { path: '**', redirectTo: 'home' },
];
