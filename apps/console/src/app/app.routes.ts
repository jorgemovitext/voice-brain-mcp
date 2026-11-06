import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
    title: 'Acceso · Hive',
  },
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
    title: 'La colmena · Hive',
  },
  {
    path: 'contacts',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contacts/contacts').then((m) => m.ContactsPage),
    title: 'Contactos · Hive',
  },
  {
    path: 'contacts/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    title: 'Conversación · Hive',
  },
  {
    path: 'conversations',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/conversations/conversations-index').then((m) => m.ConversationsIndexPage),
    title: 'Conversaciones · Hive',
  },
  {
    path: 'conversations/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/contact-detail/contact-detail').then((m) => m.ContactDetailPage),
    // withComponentInputBinding también bindea route.data → input withThreads
    data: { withThreads: true },
    title: 'Conversaciones · Hive',
  },
  {
    path: 'equipo',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/equipo/equipo').then((m) => m.EquipoPage),
    title: 'Equipo · Hive',
  },
  {
    path: 'canales',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/canales/canales').then((m) => m.CanalesPage),
    title: 'Canales · Hive',
  },
  {
    path: 'agentes',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/agentes').then((m) => m.AgentesPage),
    title: 'Agentes · Hive',
  },
  /* Antes de `agentes/:id`: si no, "nuevo" se leería como el id de un agente. */
  {
    path: 'agentes/nuevo',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/agente-nuevo').then((m) => m.AgenteNuevoPage),
    title: 'Crear agente · Hive',
  },
  {
    path: 'agentes/cambio',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/cambio-agente').then((m) => m.CambioAgentePage),
    title: 'Cambio de agente · Hive',
  },
  {
    path: 'agentes/nuevo/asistente',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/asistente-alta').then((m) => m.AsistenteAltaPage),
    title: 'Crear agente · Hive',
  },
  {
    path: 'agentes/nuevo/flujo',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/agente-asistente').then((m) => m.AgenteAsistentePage),
    title: 'Crear con flujo · Hive',
  },
  {
    path: 'agentes/:id/flujo',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/agente-flujo').then((m) => m.AgenteFlujoPage),
    title: 'Flujo · Hive',
  },
  {
    path: 'agentes/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/agentes/agente-detalle').then((m) => m.AgenteDetallePage),
    title: 'Agente · Hive',
  },
  /* El panal de NL Pearl vivía acá. Tras el cambio de motor leía de una API
     que ya no responde —era una pantalla de error con forma de panal—, así
     que el panal se mudó a /agentes con los agentes de verdad. Se redirige y
     no se borra a secas: hay enlaces guardados. */
  { path: 'workers', redirectTo: 'agentes', pathMatch: 'full' },
  {
    path: 'actividad',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/integrations/integrations').then((m) => m.IntegrationsPage),
    title: 'Actividad · Hive',
  },
  /* La ruta vieja sigue viva: hay enlaces guardados y la usaban otras vistas. */
  { path: 'integrations', pathMatch: 'full', redirectTo: 'actividad' },
  {
    path: 'uso',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/facturacion/uso').then((m) => m.UsoPage),
    title: 'Uso y facturación · Hive',
  },
  {
    path: 'planes',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/facturacion/planes').then((m) => m.PlanesPage),
    title: 'Planes · Hive',
  },
  {
    path: 'seguimiento',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/seguimiento/seguimiento').then((m) => m.SeguimientoPage),
    title: 'Seguimiento · Hive',
  },
  /* La pantalla de Cambio de agente enlazaba a /integraciones, que no existe:
     caía en el comodín y devolvía al inicio. Ahora hay planes de verdad. */
  { path: 'integraciones', pathMatch: 'full', redirectTo: 'planes' },
  {
    path: 'perfil',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/profile/profile').then((m) => m.ProfilePage),
    title: 'Tu cuenta · Hive',
  },
  {
    path: 'demo',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/demo/demo').then((m) => m.DemoPage),
    title: 'Demo del flujo · Hive',
  },
  { path: '**', redirectTo: 'home' },
];
