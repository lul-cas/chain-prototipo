import { ApiProblem } from './api-problem';

/**
 * The `Idempotency-Key` of one intent (ADR-0008 §4; ADR-0010 D4; requests-ui.md §1.5). A retry keeps the key until a
 * definitive answer, so a command whose answer was lost, or hidden behind a 502–504, can't act twice. After a definitive
 * answer, the next attempt is a new intent with a new key. Each command of a page has its own, so one command never
 * sends another's key.
 */
export class CommandKey {
  private pending: string | null = null;

  /** The key for the next attempt. */
  next(): string {
    this.pending ??= crypto.randomUUID();
    return this.pending;
  }

  /** Records how the attempt ended: with no problem, or with the problem the server (or the network) gave. */
  settle(problem?: ApiProblem): void {
    if (!problem || isDefinitive(problem.status)) {
      this.pending = null;
    }
  }
}

/**
 * No response, or a 502–504 from a proxy: the command may have been applied, and the page offers "Tentar novamente",
 * which sends the same request with the same key (ADR-0010 D4; requests-ui.md §1.5).
 */
export function offersRetry(problem: ApiProblem): boolean {
  return problem.status === 0 || (problem.status >= 502 && problem.status <= 504);
}

/** A 4xx other than 408 and 429 (ADR-0010 D4). No response, 408, 429 and 5xx leave the outcome open for a retry. */
function isDefinitive(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
