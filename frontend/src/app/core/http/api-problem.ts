import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

/**
 * A failed API call as the app sees it (ADR-0010 D4): the RFC 9457 problem details of the API, reduced to what screens use.
 * `code` is the API's machine-readable code; `network_error` when no response arrived, `http_<status>` without a problem body.
 */
export interface ApiProblem {
  readonly kind: 'api-problem';
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number;
  readonly code: string;
  readonly title: string | null;
  /** `validation_failed` lists codes; submissions list `{ key, code }` (forms.md §F1). */
  readonly errors: readonly unknown[];
  /**
   * The problem's other members, such as what uses an item in a 409 `destination_in_use` (automation-ui.md §12.1). Every
   * problem the interceptor makes has them; a page's own fallback problem may leave them out.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** The members of RFC 9457 and Chain's own, which the fields above already carry. */
const KNOWN = new Set(['type', 'title', 'status', 'detail', 'instance', 'code', 'errors', 'traceId']);

export function isApiProblem(value: unknown): value is ApiProblem {
  return typeof value === 'object' && value !== null && (value as Partial<ApiProblem>).kind === 'api-problem';
}

/** The codes listed by a `validation_failed` problem. */
export function errorCodes(problem: ApiProblem): string[] {
  return problem.errors.filter((error): error is string => typeof error === 'string');
}

export function toApiProblem(response: HttpErrorResponse): ApiProblem {
  if (response.status === 0) {
    return { kind: 'api-problem', status: 0, code: 'network_error', title: null, errors: [], extensions: {} };
  }

  const body: unknown = response.error;
  const problem = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    kind: 'api-problem',
    status: response.status,
    code: typeof problem['code'] === 'string' ? problem['code'] : `http_${response.status}`,
    title: typeof problem['title'] === 'string' ? problem['title'] : null,
    errors: Array.isArray(problem['errors']) ? problem['errors'] : [],
    extensions: Object.fromEntries(Object.entries(problem).filter(([name]) => !KNOWN.has(name))),
  };
}

/** Turns every failed response into an {@link ApiProblem}, so callers never handle raw HTTP errors. */
export const apiProblemInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(
    catchError((error: unknown) => throwError(() => (error instanceof HttpErrorResponse ? toApiProblem(error) : error))),
  );
