import { isValidHost } from '../../../core/text/host-name';
import { storable } from '../../../core/text/storable';

/** A destination's settings, as `PUT` takes them: every one, since an absent one goes back to its default (automation.md §3.2). */
export interface DestinationSettings {
  readonly description: string | null;
  readonly scheme: string;
  readonly host: string;
  readonly port: number | null;
  readonly pathPrefix: string | null;
  readonly internal: boolean;
  readonly allowSecretsOverHttp: boolean;
  readonly maxRequestBytes: number | null;
  readonly maxResponseBytes: number | null;
}

export type SizeUnit = 'bytes' | 'KiB' | 'MiB';

export const DEFAULT_MAX_BYTES = 1_048_576;
const MIN_MAX_BYTES = 1024;
const MAX_MAX_BYTES = 10_485_760;
const MAX_DESCRIPTION = 500;
const MAX_PATH_PREFIX = 500;
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** .NET's `char.IsWhiteSpace` or `char.IsControl`, as the server reads a path prefix: JavaScript's \s also takes U+FEFF (#124). */
const DOTNET_SPACE_OR_CONTROL = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\p{Cc}]/u;
const UNITS: readonly (readonly [SizeUnit, number])[] = [
  ['MiB', 1_048_576],
  ['KiB', 1024],
  ['bytes', 1],
];

/**
 * The API codes a destination would get, in the order the server's `Destination` checks them (automation.md §3.1). The
 * panel shows them as the admin types (automation-ui.md §3.2); the server's answer wins. `name` is checked on create only.
 */
export function destinationProblems(settings: DestinationSettings, name?: string): string[] {
  const codes: string[] = [];
  if (name !== undefined && !NAME.test(name)) {
    codes.push('invalid_name');
  }
  if (settings.description !== null && settings.description.length > MAX_DESCRIPTION) {
    codes.push('description_too_long');
  } else if (settings.description !== null && !storable(settings.description)) {
    codes.push('invalid_description');
  }
  if (settings.scheme !== 'https' && settings.scheme !== 'http') {
    codes.push('invalid_scheme');
  } else if (settings.scheme === 'http' && !settings.internal) {
    codes.push('http_requires_internal');
  }
  if (settings.allowSecretsOverHttp && settings.scheme !== 'http') {
    codes.push('secrets_over_http_requires_http');
  }
  if (!isValidHost(settings.host)) {
    codes.push('invalid_host');
  }
  if (settings.port !== null && (settings.port < 1 || settings.port > 65_535)) {
    codes.push('invalid_port');
  }
  if (settings.pathPrefix !== null && !isValidPathPrefix(settings.pathPrefix)) {
    codes.push('invalid_path_prefix');
  }
  if (settings.maxRequestBytes !== null && (settings.maxRequestBytes < MIN_MAX_BYTES || settings.maxRequestBytes > MAX_MAX_BYTES)) {
    codes.push('invalid_max_request_bytes');
  }
  if (settings.maxResponseBytes !== null && (settings.maxResponseBytes < MIN_MAX_BYTES || settings.maxResponseBytes > MAX_MAX_BYTES)) {
    codes.push('invalid_max_response_bytes');
  }
  return codes;
}

/** `https://api.erp.example:8443/v1`: the port and the prefix only when set; a wildcard host as it is. */
export function addressText(settings: Pick<DestinationSettings, 'scheme' | 'host' | 'port' | 'pathPrefix'>): string {
  return `${settings.scheme}://${settings.host}${settings.port !== null ? `:${settings.port}` : ''}${settings.pathPrefix ?? ''}`;
}

/** A size in the largest unit that holds it exactly (automation-ui.md §3.2). */
export function sizeParts(bytes: number): { readonly amount: number; readonly unit: SizeUnit } {
  const [unit, size] = UNITS.find(([, factor]) => bytes % factor === 0)!;
  return { amount: bytes / size, unit };
}

export function sizeText(bytes: number): string {
  const { amount, unit } = sizeParts(bytes);
  return `${amount} ${unit}`;
}

export function bytesOf(amount: number, unit: SizeUnit): number {
  return amount * UNITS.find(([candidate]) => candidate === unit)![1];
}

/** Starts with `/`; no `..`, `?`, `#`, a percent-encoded `/`, whitespace or control characters. */
function isValidPathPrefix(prefix: string): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= MAX_PATH_PREFIX &&
    prefix.startsWith('/') &&
    !prefix.includes('..') &&
    !prefix.includes('?') &&
    !prefix.includes('#') &&
    !prefix.toLowerCase().includes('%2f') &&
    !DOTNET_SPACE_OR_CONTROL.test(prefix)
  );
}
