import { APIRequestContext, expect, request } from '@playwright/test';

export const BASE_URL = process.env['CHAIN_E2E_BASE_URL'] ?? 'http://localhost:54200';

/**
 * An API session through the frontend origin, as the browser has it: `/api` is proxied to the API, and state-changing calls
 * carry the frontend's `Origin` (identity.md, CSRF).
 */
export async function apiSession(username: string, password: string): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const login = await api.post('/api/auth/login', { data: { username, password } });
  expect(login.status(), `login of ${username}`).toBe(204);
  return api;
}

/** The admin that global setup prepared. */
export function adminSession(): Promise<APIRequestContext> {
  return apiSession(process.env['CHAIN_E2E_ADMIN_USER']!, process.env['CHAIN_E2E_ADMIN_PASSWORD']!);
}

/** A name no other test uses. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A new user with a temporary password; each test makes its own (ADR-0010 D6). */
export async function createUser(displayName: string): Promise<{ id: string; username: string; displayName: string; temporaryPassword: string }> {
  const admin = await adminSession();
  const username = unique('e2e');
  const created = await admin.post('/api/admin/users', { data: { username, displayName, isAdmin: false } });
  expect(created.status()).toBe(201);
  const { user, temporaryPassword } = (await created.json()) as { user: { id: string }; temporaryPassword: string };
  await admin.dispose();
  return { id: user.id, username, displayName, temporaryPassword };
}

/** A user who already replaced the temporary password, so the browser can sign in directly. */
export async function createReadyUser(displayName: string, password: string): Promise<{ id: string; username: string }> {
  const user = await createUser(displayName);
  const api = await apiSession(user.username, user.temporaryPassword);
  const changed = await api.post('/api/auth/change-password', { data: { currentPassword: user.temporaryPassword, newPassword: password } });
  expect(changed.status()).toBe(204);
  await api.dispose();
  return { id: user.id, username: user.username };
}

/** A write guarded by the resource's current ETag (ADR-0008 §3), for drafts, publishing and grants. */
export async function withETag(api: APIRequestContext, method: 'put' | 'post', path: string, data?: unknown): Promise<void> {
  const current = await api.get(path.replace(/\/(draft|publish|grants)$/, ''));
  const etag = current.headers()['etag'];
  const response = await api[method](path, { data, headers: { 'If-Match': etag } });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
}
