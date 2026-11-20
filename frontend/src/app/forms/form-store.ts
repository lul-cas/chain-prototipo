import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { EVALUATION_ZONE_MINUTES, instantFromEpochMilliseconds } from '../expression';
import { Evaluation, evaluateForm } from './evaluation';
import { fieldMessage } from './messages';
import { FieldErrorView, FormComponent, FormDocument, childPath, producesValue, rowPath } from './model';
import { FieldFile, FileUploads, PendingUpload, isPendingUpload } from './uploads';
import { EditableObject, EditableValue, emptyRow, initialValues } from './values';

let nextUpload = 0;

/** The renderer's clock, in milliseconds since 1970: relative bounds and `currentDate` read it. Tests replace it. */
export const FORM_CLOCK = new InjectionToken<() => number>('chain.FormClock', { providedIn: 'root', factory: () => () => Date.now() });

/** Where a value lives in the value tree: keys, and row indexes inside dynamic lists. */
export type ValuePath = readonly (string | number)[];

/** One field with an error, for the error summary. */
export interface SummaryItem {
  readonly path: string;
  readonly label: string;
  readonly message: string;
}

/** The state of one rendered form (forms.md F3): its values, what was touched, and the errors to show. */
@Injectable()
export class FormStore {
  private readonly clock = inject(FORM_CLOCK);
  private readonly controls = new Map<string, string>();
  /** Uploads on their way, by the id their pending entry holds; they stop with the form. */
  private readonly uploads = new Map<string, Subscription>();

  readonly document = signal<FormDocument>({ schemaVersion: 1, components: [] });
  /** The request's data with the prefill on top, which conditions and computed fields read around the form. */
  readonly base = signal<Readonly<Record<string, unknown>>>({});
  readonly values = signal<EditableObject>({});
  readonly touched = signal<ReadonlySet<string>>(new Set());
  /** True once a submit was tried: every client error then shows. */
  readonly attempted = signal(false);
  readonly serverErrors = signal<ReadonlyMap<string, string>>(new Map());
  readonly disabled = signal(false);

  readonly evaluation = computed<Evaluation>(() =>
    evaluateForm(this.document(), this.values(), this.base(), { now: instantFromEpochMilliseconds(this.clock()), zone: EVALUATION_ZONE_MINUTES }),
  );

  /** Server errors the renderer can't place on a visible field: a key such as `""`, or a key the form doesn't show. */
  readonly formErrors = computed(() => {
    const fields = this.evaluation().fields;
    return [...this.serverErrors()]
      .filter(([path]) => fields.get(path)?.visible !== true)
      .map(([path, code]) => (path ? `${fieldMessage(code, null)} (${path})` : fieldMessage(code, null)));
  });

  /** Every visible field with a message to show, in document order. */
  readonly summary = computed<readonly SummaryItem[]>(() =>
    fieldsInOrder(this.document().components, this.values(), '').flatMap(({ path, component }) => {
      const message = this.messageFor(path, component);
      return message ? [{ path, label: component.label ?? path, message }] : [];
    }),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.uploads.forEach((upload) => upload.unsubscribe()));
  }

  load(document: FormDocument, prefill: Readonly<Record<string, unknown>>, context: Readonly<Record<string, unknown>>): void {
    this.document.set(document);
    this.base.set({ ...context, ...prefill });
    this.values.set(initialValues(document.components, prefill));
    this.touched.set(new Set());
    this.attempted.set(false);
  }

  showServerErrors(errors: readonly FieldErrorView[]): void {
    this.serverErrors.set(new Map(errors.map((error) => [error.key, error.code])));
  }

  valueAt(path: ValuePath): EditableValue | undefined {
    let current: unknown = this.values();
    for (const segment of path) {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }
      current = (current as Record<string | number, unknown>)[segment];
    }
    return current as EditableValue | undefined;
  }

  setValue(path: ValuePath, errorPath: string, value: EditableValue): void {
    this.values.update((values) => setIn(values, path, 0, value) as EditableObject);
    this.clearServerErrors(errorPath);
  }

  addRow(path: ValuePath, list: FormComponent, errorPath: string): void {
    const rows = (this.valueAt(path) as readonly EditableObject[] | undefined) ?? [];
    this.setValue(path, errorPath, [...rows, emptyRow(list)]);
  }

  removeRow(path: ValuePath, index: number, errorPath: string): void {
    const rows = (this.valueAt(path) as readonly EditableObject[] | undefined) ?? [];
    this.setValue(path, errorPath, rows.filter((_, i) => i !== index));
    this.touched.update((touched) => new Set([...touched].filter((p) => !p.startsWith(`${errorPath}[`))));
  }

  /**
   * Uploads `file` into the file field at `path` (forms.md F3, "File fields"). It is held there as a pending entry, which
   * moves with its row, until the server answers: then it becomes the stored file, or goes with the refusal's text.
   */
  upload(path: ValuePath, errorPath: string, file: File, uploads: FileUploads, refused: (text: string) => void): void {
    const pending: PendingUpload = { uploadId: `upload-${nextUpload++}`, name: file.name };
    const current = this.valueAt(path);
    this.setValue(path, errorPath, [...(Array.isArray(current) ? (current as readonly EditableObject[]) : []), pending]);
    const upload = uploads.upload(file).subscribe({
      next: (stored) => this.settleUpload(pending.uploadId, stored),
      error: (error: unknown) => {
        this.settleUpload(pending.uploadId, null);
        refused(typeof error === 'string' ? error : 'Não foi possível enviar o arquivo.');
      },
    });
    if (!upload.closed) {
      this.uploads.set(pending.uploadId, upload);
    }
  }

  /** Stops an upload and takes its entry off the field. */
  cancelUpload(uploadId: string): void {
    this.uploads.get(uploadId)?.unsubscribe();
    this.settleUpload(uploadId, null);
  }

  touch(path: string): void {
    if (!this.touched().has(path)) {
      this.touched.update((touched) => new Set(touched).add(path));
    }
  }

  /** The message for the field at `path`: a server error until the field is edited, else its first client error once shown. */
  messageFor(path: string, component: FormComponent): string | null {
    const server = this.serverErrors().get(path);
    const state = this.evaluation().fields.get(path);
    if (state?.visible !== true) {
      return null;
    }
    if (server) {
      return fieldMessage(server, component);
    }
    if (state.uploading && this.attempted()) {
      return 'Aguarde o fim do envio dos arquivos.';
    }
    if (state.errors.length === 0 || (!this.attempted() && !this.touched().has(path))) {
      return null;
    }
    return fieldMessage(state.errors[0], component);
  }

  /** The id of the control that shows `path`, registered by the field when it renders; the summary links to it. */
  controlId(path: string): string | null {
    return this.controls.get(path) ?? null;
  }

  registerControl(path: string, id: string): void {
    this.controls.set(path, id);
  }

  unregisterControl(path: string, id: string): void {
    if (this.controls.get(path) === id) {
      this.controls.delete(path);
    }
  }

  /** Puts the stored file in place of the pending entry, wherever its row is now, or drops the entry. */
  private settleUpload(uploadId: string, stored: FieldFile | null): void {
    this.uploads.delete(uploadId);
    this.values.update((values) => settleIn(values, uploadId, stored) as EditableObject);
  }

  /** Editing a field clears its server error and those inside it (a group or a list). */
  private clearServerErrors(path: string): void {
    const errors = this.serverErrors();
    const kept = [...errors].filter(([key]) => key !== path && !key.startsWith(`${path}.`) && !key.startsWith(`${path}[`));
    if (kept.length !== errors.size) {
      this.serverErrors.set(new Map(kept));
    }
  }
}

function settleIn(value: unknown, uploadId: string, stored: FieldFile | null): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (isPendingUpload(item) && item.uploadId === uploadId ? (stored ? [stored] : []) : [settleIn(item, uploadId, stored)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settleIn(item, uploadId, stored)]));
  }
  return value;
}

function setIn(container: unknown, path: ValuePath, index: number, value: EditableValue): unknown {
  if (index === path.length) {
    return value;
  }
  const segment = path[index];
  if (Array.isArray(container)) {
    return container.map((item, i) => (i === segment ? setIn(item, path, index + 1, value) : item));
  }
  const object = (typeof container === 'object' && container !== null ? container : {}) as Record<string, unknown>;
  return { ...object, [segment]: setIn(object[segment as string], path, index + 1, value) };
}

/** Value-producing fields with their error paths, in document order, rows included. */
function fieldsInOrder(components: readonly FormComponent[], values: unknown, prefix: string): { path: string; component: FormComponent }[] {
  const source = (typeof values === 'object' && values !== null ? values : {}) as Record<string, unknown>;
  return components.flatMap((component) => {
    if (!producesValue(component) || !component.key) {
      return [];
    }
    const path = childPath(prefix, component.key);
    const self = { path, component };
    if (component.type === 'group') {
      return [self, ...fieldsInOrder(component.components ?? [], source[component.key], path)];
    }
    if (component.type === 'dynamicList') {
      const rows = Array.isArray(source[component.key]) ? (source[component.key] as unknown[]) : [];
      return [self, ...rows.flatMap((row, i) => fieldsInOrder(component.components ?? [], row, rowPath(path, i)))];
    }
    return [self];
  });
}
