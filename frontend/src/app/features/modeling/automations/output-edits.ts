import { MAX_INPUTS } from './automation-checks';
import { DOCUMENT_ORDER, EditorDraft, Json, isObject, withMember } from './automation-edits';
import { PathSegment } from './output-path';

/** At most 50 outputs, as inputs (AU001). */
export const MAX_OUTPUTS = MAX_INPUTS;
const OUTPUT_ORDER = ['key', 'type', 'required', 'source', 'path'];

/** *Corpo da resposta* or *Status HTTP* (automation-ui.md §7.4). */
export type OutputSource = 'body' | 'status';

/** The draft's outputs, `[]` when it has none. */
export function outputsOf(json: Json): readonly Json[] {
  const outputs = json['outputs'];
  return Array.isArray(outputs) ? (outputs as Json[]) : [];
}

/** Adds an output at the end: read from the body at an empty path, with an empty key, of type text, optional; null at 50. */
export function addOutput(draft: EditorDraft, id: string): EditorDraft | null {
  const outputs = outputsOf(draft.json);
  if (outputs.length >= MAX_OUTPUTS) {
    return null;
  }
  const added = { key: '', type: 'text', required: false, source: 'body', path: [] };
  return { ...draft, json: withMember(draft.json, 'outputs', [...outputs, added], DOCUMENT_ORDER), outputIds: [...draft.outputIds, id] };
}

export function removeOutput(draft: EditorDraft, index: number): EditorDraft {
  return {
    ...draft,
    json: withMember(draft.json, 'outputs', outputsOf(draft.json).filter((_, i) => i !== index), DOCUMENT_ORDER),
    outputIds: draft.outputIds.filter((_, i) => i !== index),
  };
}

/** Moves an output one place up (-1) or down (1); null past either end. */
export function moveOutput(draft: EditorDraft, index: number, by: -1 | 1): EditorDraft | null {
  const outputs = outputsOf(draft.json);
  const other = index + by;
  if (index < 0 || other < 0 || other >= outputs.length) {
    return null;
  }
  return { ...draft, json: withMember(draft.json, 'outputs', swap(outputs, index, other), DOCUMENT_ORDER), outputIds: swap(draft.outputIds, index, other) };
}

export function setOutputKey(draft: EditorDraft, index: number, key: string): EditorDraft {
  return change(draft, index, (output) => (output['key'] === key ? output : withMember(output, 'key', key, OUTPUT_ORDER)));
}

export function setOutputType(draft: EditorDraft, index: number, type: string): EditorDraft {
  return change(draft, index, (output) => (output['type'] === type ? output : withMember(output, 'type', type, OUTPUT_ORDER)));
}

export function setOutputRequired(draft: EditorDraft, index: number, required: boolean): EditorDraft {
  return change(draft, index, (output) => (output['required'] === required ? output : withMember(output, 'required', required, OUTPUT_ORDER)));
}

/** The path's segments, as its text form reads them (§7.4). */
export function setOutputPath(draft: EditorDraft, index: number, path: readonly PathSegment[]): EditorDraft {
  return change(draft, index, (output) => (JSON.stringify(output['path']) === JSON.stringify(path) ? output : withMember(output, 'path', [...path], OUTPUT_ORDER)));
}

/** *Status HTTP* is a number without a path (AU010); *Corpo da resposta* reads a path, empty until it is written. */
export function setOutputSource(draft: EditorDraft, index: number, source: OutputSource): EditorDraft {
  return change(draft, index, (output) => {
    if (source === 'status') {
      if (output['source'] === 'status' && output['type'] === 'number' && !('path' in output)) {
        return output;
      }
      const statusOutput = withMember(withMember(output, 'source', 'status', OUTPUT_ORDER), 'type', 'number', OUTPUT_ORDER);
      return Object.fromEntries(Object.entries(statusOutput).filter(([member]) => member !== 'path'));
    }
    return output['source'] === 'body' ? output : withMember(withMember(output, 'source', 'body', OUTPUT_ORDER), 'path', Array.isArray(output['path']) ? output['path'] : [], OUTPUT_ORDER);
  });
}

/** Resposta (§7.4): `json` or `none`. */
export function setResponseType(draft: EditorDraft, type: string): EditorDraft {
  const response = isObject(draft.json['response']) ? draft.json['response'] : {};
  return response['type'] === type ? draft : { ...draft, json: withMember(draft.json, 'response', { ...response, type }, DOCUMENT_ORDER) };
}

function change(draft: EditorDraft, index: number, edit: (output: Json) => Json): EditorDraft {
  const outputs = outputsOf(draft.json);
  const output = outputs[index];
  if (output === undefined) {
    return draft;
  }
  const changed = edit(output);
  return changed === output ? draft : { ...draft, json: withMember(draft.json, 'outputs', outputs.map((candidate, i) => (i === index ? changed : candidate)), DOCUMENT_ORDER) };
}

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}
