/** The NUL character, and half of a UTF-16 pair: text PostgreSQL can't store (identity.md I1), which the API refuses. */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether the API can store this text (identity.md I1). */
export function storable(text: string): boolean {
  return !UNSTORABLE.test(text);
}
