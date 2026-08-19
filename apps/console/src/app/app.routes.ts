import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
    title: 'Inicio · Brain',
  },
  {
    path: 'contacts',
    loadComponent: () => import('./pages/contacts/contacts').then((m) => m.ContactsPage),
    title: 'Contactos · Brain',
  },
  {
    path: 'contacts/:id',
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    title: 'Conversación · Brain',
  },
  {
    path: 'conversations',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/conversations/conversations-index').then((m) => m.ConversationsIndexPage),
    title: 'Conversaciones · Brain',
  },
  {
    path: 'conversations/:id',
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    // withComponentInputBinding también bindea route.data → input withThreads
    data: { withThreads: true },
    title: 'Conversaciones · Brain',
  },
  {
    path: 'workers',
    loadComponent: () => import('./pages/workers/workers').then((m) => m.WorkersPage),
    title: 'Obreros · Brain',
  },
  {
    path: 'integrations',
    loadComponent: () => import('./pages/integrations/integrations').then((m) => m.IntegrationsPage),
    title: 'Integraciones · Brain',
  },
  {
    path: 'demo',
    loadComponent: () => import('./pages/demo/demo').then((m) => m.DemoPage),
    title: 'Demo del flujo · Brain',
  },
  { path: '**', redirectTo: 'home' },
];
