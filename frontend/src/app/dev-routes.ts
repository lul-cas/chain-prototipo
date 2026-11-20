import { Routes } from '@angular/router';

export const devRoutes: Routes = [
  {
    path: '_design',
    title: 'Sistema de design · Chain',
    loadComponent: () => import('./ui/design/design-page').then((m) => m.DesignPage),
  },
  {
    path: '_formulario',
    title: 'Formulário de exemplo · Chain',
    loadComponent: () => import('./forms/form-preview-page').then((m) => m.FormPreviewPage),
  },
];
