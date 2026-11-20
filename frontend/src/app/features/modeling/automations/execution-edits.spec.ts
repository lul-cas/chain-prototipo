import { documentOf, fromDraft } from './automation-edits';
import { setExecution } from './execution-edits';

function load(execution?: object) {
  let n = 0;
  return fromDraft(
    { schemaVersion: 1, kind: 'http', request: { method: 'POST', destination: 'erp', path: '/' }, response: { type: 'none' }, ...(execution ? { execution } : {}) },
    () => `x${++n}`,
  );
}

const DEFAULTS = { timeoutSeconds: 30, retry: { maxAttempts: 5, initialDelaySeconds: 5 }, idempotency: { mode: 'header', header: 'Idempotency-Key' }, redirects: { follow: false, max: 0 } };

describe('execution edits (automation-ui.md §7.5)', () => {
  it('writes the whole execution object, every value explicit, with the change', () => {
    expect(documentOf(setExecution(load(), { maxAttempts: 1 }))['execution']).toEqual({ ...DEFAULTS, retry: { maxAttempts: 1, initialDelaySeconds: 5 } });
    expect(Object.keys(documentOf(setExecution(load(), { timeoutSeconds: 10 })))).toEqual(['schemaVersion', 'kind', 'request', 'response', 'execution']);
  });

  it('leaves no idempotency header when the key is not sent', () => {
    expect(documentOf(setExecution(load(), { idempotency: { mode: 'none' } }))['execution']).toEqual({ ...DEFAULTS, idempotency: { mode: 'none' } });
    expect(documentOf(setExecution(load({ idempotency: { mode: 'none' } }), { idempotency: { mode: 'header', header: 'X-Chave' } }))['execution']).toEqual({
      ...DEFAULTS,
      idempotency: { mode: 'header', header: 'X-Chave' },
    });
  });

  it('keeps the other values as they are, and changes nothing when the values are the same', () => {
    const draft = load({ timeoutSeconds: 60, redirects: { follow: true, max: 2 } });

    expect(documentOf(setExecution(draft, { initialDelaySeconds: 10 }))['execution']).toEqual({
      ...DEFAULTS,
      timeoutSeconds: 60,
      retry: { maxAttempts: 5, initialDelaySeconds: 10 },
      redirects: { follow: true, max: 2 },
    });
    const explicit = load(DEFAULTS);
    expect(setExecution(explicit, { timeoutSeconds: 30 })).toBe(explicit);
  });
});
