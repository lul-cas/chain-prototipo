import { ApiProblem } from './api-problem';
import { CommandKey, offersRetry } from './command-key';

/** How an attempt failed: with no response (0) or with an HTTP status and no problem body. */
function failure(status: number): ApiProblem {
  return { kind: 'api-problem', status, code: status === 0 ? 'network_error' : `http_${status}`, title: null, errors: [] };
}

describe('CommandKey (ADR-0010 D4; requests-ui.md §1.5)', () => {
  it('sends the same key until the attempt ends', () => {
    const key = new CommandKey();

    expect(key.next()).toBe(key.next());
  });

  it.each([0, 408, 429, 500, 502, 503, 504])('keeps the key for the retry after %i, which is not a definitive answer', (status) => {
    const key = new CommandKey();
    const first = key.next();

    key.settle(failure(status));

    expect(key.next()).toBe(first);
  });

  it.each([400, 403, 404, 409, 412, 422])('takes a new key after %i, a definitive answer', (status) => {
    const key = new CommandKey();
    const first = key.next();

    key.settle(failure(status));

    expect(key.next()).not.toBe(first);
  });

  it('takes a new key after a success', () => {
    const key = new CommandKey();
    const first = key.next();

    key.settle();

    expect(key.next()).not.toBe(first);
  });
});

describe('offersRetry (ADR-0010 D4; requests-ui.md §1.5, card #156)', () => {
  it.each([0, 502, 503, 504])('offers "Tentar novamente" after %i, a lost answer', (status) => {
    expect(offersRetry(failure(status))).toBe(true);
  });

  it.each([400, 408, 409, 422, 429, 500, 501, 505])('leaves %i to its own message', (status) => {
    expect(offersRetry(failure(status))).toBe(false);
  });
});
