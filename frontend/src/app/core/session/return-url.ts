/**
 * The page to open after login or a password change: a path inside the app, never another site and never the login page
 * itself (identity.md, UI). Anything else falls back to the start page.
 */
export function safeReturnUrl(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/entrar')) {
    return '/';
  }
  return value;
}
