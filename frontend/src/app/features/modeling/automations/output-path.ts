/** A segment of an output's path (automation.md §5.2): a property name, or a list position from 0. */
export type PathSegment = string | number;

/** The text form read back as segments, or why it can't be. */
export type ParsedPath = { readonly segments: PathSegment[] } | { readonly error: string };

/** What a plain name can't hold: the text form's own characters. */
const SPECIAL = '.[]" ';
const INDEX = /^(0|[1-9][0-9]*)$/;
const MAX_INDEX = 2_147_483_647; // the server reads a position as a 32-bit integer (AU010)

const EMPTY = 'Informe o caminho na resposta, como resultado.situacao.';
const EMPTY_NAME = 'O caminho tem um nome vazio entre pontos.';
const NEEDS_BRACKETS = 'Um nome com ponto, colchete, aspas ou espaço vai entre colchetes e aspas, como ["nome completo"].';
const BAD_INDEX = 'Entre colchetes vai a posição de um item, a partir de 0, como itens[0], ou um nome entre aspas.';
const OPEN_QUOTE = 'Feche o nome entre aspas e colchetes, como ["nome.completo"].';
const BAD_STRING = 'O nome entre colchetes é um texto JSON, como ["nome.completo"].';
const SEPARATOR = 'Separe os nomes com ponto, como resultado.situacao.';

/**
 * The path's text form (automation-ui.md §7.4): names as they are, separated by `.`; `[n]` for the element *n* of a list; a
 * name that is empty or holds `.`, `[`, `]`, `"` or a space, in brackets as a JSON string, such as `["nome.completo"]`.
 */
export function formatPath(segments: readonly PathSegment[]): string {
  return segments
    .map((segment, i) => {
      if (typeof segment === 'number') {
        return `[${segment}]`;
      }
      if (segment === '' || [...SPECIAL].some((character) => segment.includes(character))) {
        return `[${JSON.stringify(segment)}]`;
      }
      return i === 0 ? segment : `.${segment}`;
    })
    .join('');
}

/** Reads the text form back. A plain segment is always a name, even all digits: `a.0` reads the property "0", `a[0]` the first element. */
export function parsePath(text: string): ParsedPath {
  if (text === '') {
    return { error: EMPTY };
  }
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[') {
      const read = text[i + 1] === '"' ? quoted(text, i) : position(text, i);
      if ('error' in read) {
        return read;
      }
      segments.push(read.segment);
      i = read.next;
      continue;
    }
    if (segments.length > 0) {
      if (text[i] !== '.') {
        return { error: SPECIAL.includes(text[i]) ? NEEDS_BRACKETS : SEPARATOR };
      }
      i++;
    }
    let end = i;
    while (end < text.length && !SPECIAL.includes(text[end])) {
      end++;
    }
    if (end === i) {
      return { error: text[i] === undefined || text[i] === '.' ? EMPTY_NAME : NEEDS_BRACKETS };
    }
    segments.push(text.slice(i, end));
    i = end;
  }
  return { segments };
}

/** `[n]`: a list position from 0. */
function position(text: string, at: number): { segment: number; next: number } | { error: string } {
  const close = text.indexOf(']', at);
  const digits = close < 0 ? '' : text.slice(at + 1, close);
  if (!INDEX.test(digits)) {
    return { error: BAD_INDEX };
  }
  const index = Number(digits);
  return index > MAX_INDEX ? { error: 'A posição de um item vai até 2147483647.' } : { segment: index, next: close + 1 };
}

/** `["…"]`: a name as a JSON string, its escapes included. */
function quoted(text: string, at: number): { segment: string; next: number } | { error: string } {
  let end = at + 2;
  while (end < text.length && text[end] !== '"') {
    end += text[end] === '\\' ? 2 : 1;
  }
  if (end >= text.length || text[end + 1] !== ']') {
    return { error: OPEN_QUOTE };
  }
  try {
    return { segment: JSON.parse(text.slice(at + 1, end + 1)) as string, next: end + 2 };
  } catch {
    return { error: BAD_STRING };
  }
}
