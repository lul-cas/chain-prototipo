import { expect, request } from '@playwright/test';

/**
 * The stack's bootstrap admin must change its password before it can manage users (identity.md, I1). Global setup does that
 * once and hands the new password to the tests through the environment.
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env['CHAIN_E2E_BASE_URL'] ?? 'http://localhost:54200';
  const username = process.env['CHAIN_E2E_ADMIN_USER'];
  const initial = process.env['CHAIN_E2E_ADMIN_INITIAL_PASSWORD'];
  if (!username || !initial) {
    throw new Error('Run the e2e tests through e2e/run.sh, which bootstraps the admin (CHAIN_E2E_ADMIN_USER, CHAIN_E2E_ADMIN_INITIAL_PASSWORD).');
  }

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  expect((await api.post('/api/auth/login', { data: { username, password: initial } })).status()).toBe(204);
  const changed = `${initial}-e2e`;
  const change = await api.post('/api/auth/change-password', { data: { currentPassword: initial, newPassword: changed } });
  expect(change.status()).toBe(204);
  await api.dispose();
  process.env['CHAIN_E2E_ADMIN_PASSWORD'] = changed;
}
