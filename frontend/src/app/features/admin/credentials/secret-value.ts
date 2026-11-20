import { storable } from '../../../core/text/storable';

export const MAX_VALUE_BYTES = 8192;

/** Visible ASCII, spaces and tabs: what an HTTP header value can carry (automation-contract.md §3). */
const HEADER_SAFE = /^[\x20-\x7e\t]*$/;

/** Why a value can't be saved, as the API would say it (automation-ui.md §4.7), or null. */
export function valueProblem(value: string): string | null {
  if (value === '') {
    return 'Informe o valor.';
  }
  if (!storable(value)) {
    return 'O valor tem caracteres que não podem ser guardados.';
  }
  return new TextEncoder().encode(value).length > MAX_VALUE_BYTES ? 'O valor pode ter no máximo 8.192 bytes.' : null;
}

/** The warnings of §4.2, which don't block saving: spaces at the edges, and characters a header can't carry. */
export function valueWarnings(value: string): string[] {
  return [
    /^[ \t]|[ \t]$/.test(value) ? 'O valor começa ou termina com espaço. Ele será enviado assim.' : null,
    !HEADER_SAFE.test(value)
      ? 'Este valor tem caracteres que um cabeçalho HTTP não aceita, como acentos ou quebras de linha. Ele só funciona na autenticação básica.'
      : null,
  ].filter((warning): warning is string => warning !== null);
}
