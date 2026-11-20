/** The server's limit for a process name, once trimmed (workflow-definition.md §5.2). */
export const NAME_LIMIT = 100;

/**
 * What `invalid_name` means for the name that was sent (workflow-editor.md §10.1, card #172). The server gives that code both
 * for a name over the limit and for text it can't store (identity.md I1), so the length of the name tells the two apart.
 */
export function invalidNameText(name: string): string {
  return name.length > NAME_LIMIT
    ? `O nome pode ter no máximo ${NAME_LIMIT} caracteres.`
    : 'O nome tem caracteres que não podem ser guardados.';
}
