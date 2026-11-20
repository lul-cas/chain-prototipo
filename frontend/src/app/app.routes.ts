import { Routes } from '@angular/router';
import { canModel, isAdmin, passwordChangeAllowed, signedIn, signedOut } from './core/session/guards';
import { devRoutes } from './dev-routes';
import { leaveWhenSaved } from './features/modeling/can-leave';

export const routes: Routes = [
  ...devRoutes,
  {
    path: 'entrar',
    title: 'Entrar · Chain',
    canActivate: [signedOut],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'trocar-senha',
    title: 'Trocar senha · Chain',
    canActivate: [passwordChangeAllowed],
    loadComponent: () => import('./features/auth/change-password-page').then((m) => m.ChangePasswordPage),
  },
  {
    path: '',
    canActivate: [signedIn],
    loadComponent: () => import('./core/layout/app-layout').then((m) => m.AppLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tarefas' },
      {
        path: 'tarefas',
        title: 'Tarefas · Chain',
        loadComponent: () => import('./features/inbox/inbox-page').then((m) => m.InboxPage),
      },
      {
        path: 'solicitar',
        title: 'Solicitar · Chain',
        loadComponent: () => import('./features/start/start-list-page').then((m) => m.StartListPage),
      },
      {
        path: 'solicitar/:workflowId',
        title: 'Nova solicitação · Chain',
        loadComponent: () => import('./features/start/start-request-page').then((m) => m.StartRequestPage),
      },
      {
        path: 'solicitacoes',
        title: 'Solicitações · Chain',
        loadComponent: () => import('./features/requests/requests-page').then((m) => m.RequestsPage),
      },
      {
        path: 'solicitacoes/:id',
        title: 'Solicitação · Chain',
        loadComponent: () => import('./features/requests/request-page').then((m) => m.RequestPage),
      },
      {
        path: 'tarefas/:id',
        title: 'Tarefa · Chain',
        loadComponent: () => import('./features/tasks/task-page').then((m) => m.TaskPage),
      },
      {
        path: 'processos',
        title: 'Processos · Chain',
        canActivate: [canModel],
        loadComponent: () => import('./features/modeling/processes-page').then((m) => m.ProcessesPage),
      },
      {
        path: 'processos/:id',
        title: 'Processo · Chain',
        canActivate: [canModel],
        canDeactivate: [leaveWhenSaved],
        loadComponent: () => import('./features/modeling/editor/process-editor-page').then((m) => m.ProcessEditorPage),
      },
      {
        path: 'formularios',
        title: 'Formulários · Chain',
        canActivate: [canModel],
        loadComponent: () => import('./features/modeling/form-designer/forms-page').then((m) => m.FormsPage),
      },
      {
        path: 'formularios/:id',
        title: 'Formulário · Chain',
        canActivate: [canModel],
        canDeactivate: [leaveWhenSaved],
        loadComponent: () => import('./features/modeling/form-designer/form-designer-page').then((m) => m.FormDesignerPage),
      },
      {
        path: 'automacoes',
        title: 'Automações · Chain',
        canActivate: [canModel],
        loadComponent: () => import('./features/modeling/automations/automations-page').then((m) => m.AutomationsPage),
      },
      {
        path: 'automacoes/:id',
        title: 'Automação · Chain',
        canActivate: [canModel],
        canDeactivate: [leaveWhenSaved],
        loadComponent: () => import('./features/modeling/automations/automation-editor-page').then((m) => m.AutomationEditorPage),
      },
      {
        path: 'administracao/usuarios',
        title: 'Usuários · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/users/users-page').then((m) => m.UsersPage),
      },
      {
        path: 'administracao/usuarios/:id',
        title: 'Usuário · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/users/user-page').then((m) => m.UserPage),
      },
      {
        path: 'administracao/grupos',
        title: 'Grupos · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/groups/groups-page').then((m) => m.GroupsPage),
      },
      {
        path: 'administracao/grupos/:id',
        title: 'Grupo · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/groups/group-page').then((m) => m.GroupPage),
      },
      {
        path: 'administracao/bots',
        title: 'Bots · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/bots/bots-page').then((m) => m.BotsPage),
      },
      {
        path: 'administracao/bots/:id',
        title: 'Bot · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/bots/bot-page').then((m) => m.BotPage),
      },
      {
        path: 'administracao/destinos',
        title: 'Destinos · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/destinations/destinations-page').then((m) => m.DestinationsPage),
      },
      {
        path: 'administracao/credenciais',
        title: 'Credenciais · Chain',
        canActivate: [isAdmin],
        loadComponent: () => import('./features/admin/credentials/credentials-page').then((m) => m.CredentialsPage),
      },
    ],
  },
  {
    path: '**',
    title: 'Página não encontrada · Chain',
    loadComponent: () => import('./core/layout/not-found-page').then((m) => m.NotFoundPage),
  },
];
