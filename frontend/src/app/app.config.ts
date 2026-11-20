import { DATE_PIPE_DEFAULT_OPTIONS, DatePipeConfig, registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import localePt from '@angular/common/locales/pt';
import {
  ApplicationConfig,
  LOCALE_ID,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { apiProblemInterceptor } from './core/http/api-problem';
import { sessionInterceptor } from './core/session/session.interceptor';
import { SessionService } from './core/session/session.service';

registerLocaleData(localePt, 'pt-BR');

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    // Responses pass apiProblemInterceptor first, so sessionInterceptor sees API problems (ADR-0010 D4).
    provideHttpClient(withFetch(), withInterceptors([sessionInterceptor, apiProblemInterceptor])),
    // Who is signed in is known before the first route is chosen.
    provideAppInitializer(() => inject(SessionService).load()),
    { provide: LOCALE_ID, useValue: 'pt-BR' },
    // Dates and times show in UTC−03:00, the zone conditions are evaluated in, not in the browser's zone (ADR-0010 D8).
    { provide: DATE_PIPE_DEFAULT_OPTIONS, useValue: { timezone: '-0300' } satisfies DatePipeConfig },
  ],
};
