import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { isApiProblem } from '../http/api-problem';
import { SessionService } from './session.service';

/** Requests whose 401 is an answer for their caller, not a sign that the session ended. */
const OWN_ANSWERS = ['/api/auth/login', '/api/auth/me', '/api/auth/logout'];

/**
 * Reacts to the session ending or a password change being required (ADR-0010 D4): the user is sent to the right page and
 * comes back to the current one afterwards. The error still reaches the caller. Must run after `apiProblemInterceptor`.
 */
export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(SessionService);
  const router = inject(Router);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (isApiProblem(error) && !OWN_ANSWERS.includes(request.url)) {
        const returnUrl = router.url;
        if (error.status === 401) {
          session.clear();
          void router.navigate(['/entrar'], { queryParams: { returnUrl } });
        } else if (error.status === 403 && error.code === 'password_change_required') {
          void router.navigate(['/trocar-senha'], { queryParams: { returnUrl } });
        }
      }
      return throwError(() => error);
    }),
  );
};
