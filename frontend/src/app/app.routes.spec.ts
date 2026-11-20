import { routes } from './app.routes';
import { leaveWhenSaved } from './features/modeling/can-leave';
import { canModel, isAdmin, signedIn } from './core/session/guards';

describe('the route table', () => {
  it('lets only signed-in users who can model reach the modeling pages (identity.md; form-designer.md §12.1)', () => {
    const shell = routes.find((route) => route.path === '' && route.children)!;
    const modeling = shell.children!.filter((route) => /^(processos|formularios|automacoes)\b/.test(route.path ?? ''));

    expect(shell.canActivate).toContain(signedIn);
    expect(modeling.map((route) => route.path)).toEqual(['processos', 'processos/:id', 'formularios', 'formularios/:id', 'automacoes', 'automacoes/:id']);
    expect(modeling.filter((route) => !route.canActivate?.includes(canModel))).toEqual([]);
  });

  it('asks before leaving each editor with unsaved changes (workflow-editor.md §10.2, form-designer.md §9.1, automation-ui.md §8.1)', () => {
    const shell = routes.find((route) => route.path === '' && route.children)!;
    const editors = shell.children!.filter((route) => route.canDeactivate?.includes(leaveWhenSaved)).map((route) => route.path);

    expect(editors).toEqual(['processos/:id', 'formularios/:id', 'automacoes/:id']);
  });

  it('lets only admins reach the admin pages (automation-ui.md §2; admin-ui.md §3)', () => {
    const shell = routes.find((route) => route.path === '' && route.children)!;
    const admin = shell.children!.filter((route) => (route.path ?? '').startsWith('administracao'));

    expect(admin.map((route) => route.path)).toEqual([
      'administracao/usuarios',
      'administracao/usuarios/:id',
      'administracao/grupos',
      'administracao/grupos/:id',
      'administracao/bots',
      'administracao/bots/:id',
      'administracao/destinos',
      'administracao/credenciais',
    ]);
    expect(admin.filter((route) => !route.canActivate?.includes(isAdmin))).toEqual([]);
  });
});
