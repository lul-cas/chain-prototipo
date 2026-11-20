import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** App pages: signed in, with no password change pending (identity.md, UI). */
export const signedIn: CanActivateFn = (_route, state) => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (!session.signedIn()) {
    return router.createUrlTree(['/entrar'], { queryParams: { returnUrl: state.url } });
  }
  if (session.mustChangePassword()) {
    return router.createUrlTree(['/trocar-senha'], { queryParams: { returnUrl: state.url } });
  }
  return true;
};

/** The login page, for visitors who are not signed in. */
export const signedOut: CanActivateFn = () => (inject(SessionService).signedIn() ? inject(Router).createUrlTree(['/']) : true);

/** The password change page, for any signed-in user, whether the change is forced or not. */
export const passwordChangeAllowed: CanActivateFn = (_route, state) =>
  inject(SessionService).signedIn() || inject(Router).createUrlTree(['/entrar'], { queryParams: { returnUrl: state.url } });

/** Modeling pages, for admins and Modelers; anyone else sees the not-found page, which reveals nothing (workflow-editor.md §10.1). */
export const canModel: CanActivateFn = () =>
  inject(SessionService).user()?.canModel === true || inject(Router).parseUrl('/nao-encontrado');

/** Admin pages; anyone else sees the not-found page, which reveals nothing (automation-ui.md §2). The API stays the authority. */
export const isAdmin: CanActivateFn = () => inject(SessionService).user()?.isAdmin === true || inject(Router).parseUrl('/nao-encontrado');
