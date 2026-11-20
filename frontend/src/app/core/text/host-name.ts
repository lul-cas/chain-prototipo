/**
 * A destination's host as `Destination.IsValidHost` reads it: a lowercase DNS name in ASCII form, or `*.` and one of at least
 * two labels. IP literals, user info, ports and paths are refused: a last label of digits only would read as an address.
 */
export function isValidHost(host: string): boolean {
  if (host === '' || host.length > 253) {
    return false;
  }
  const wildcard = host.startsWith('*.');
  const labels = (wildcard ? host.slice(2) : host).split('.');
  if (wildcard && labels.length < 2) {
    return false;
  }
  return labels.every((label) => /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith('-') && !label.endsWith('-')) && !/^[0-9]+$/.test(labels[labels.length - 1]);
}
