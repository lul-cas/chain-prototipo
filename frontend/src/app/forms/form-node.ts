import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  forwardRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ExprValue, canonical } from '../expression';
import { formatDate, formatTime } from '../expression/temporal';
import { Button } from '../ui/button/button';
import { FormField } from '../ui/form-field/form-field';
import { Input } from '../ui/form-field/input';
import { FormStore, ValuePath } from './form-store';
import { FormComponent, childPath, rowPath } from './model';
import { formatNumberInput } from './numbers';
import { FILE_UPLOADS, FieldFile, formatSize, isPendingUpload, toFieldFile } from './uploads';
import { EditableObject, EditableValue, fromLocalInput, toLocalInput } from './values';

let nextId = 0;

/** A file field's file, or a file still uploading, which has no stored file yet. */
interface FileEntry {
  readonly id: string;
  readonly name: string;
  readonly file: FieldFile | null;
}

/** One component of a form document, and its children for groups and lists (forms.md F3). */
@Component({
  selector: 'chain-form-node',
  imports: [Button, FormField, Input, forwardRef(() => FormNode)],
  templateUrl: './form-node.html',
  styleUrl: './form-file.css',
  // The renderer's styles reach every level of the recursion, so they are global but scoped by class.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chain-form-node' },
})
export class FormNode {
  readonly component = input.required<FormComponent>();
  /** The error path of the container (`''` at the root). */
  readonly prefix = input.required<string>();
  /** Where the container's value lives in the value tree. */
  readonly container = input.required<ValuePath>();
  /** The position in the container, which identifies display components. */
  readonly index = input.required<number>();

  protected readonly store = inject(FormStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  protected readonly id = `chain-form-node-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly hintId = `${this.id}-hint`;

  private readonly field = viewChild(FormField);
  private readonly addButton = viewChild('add', { read: ElementRef<HTMLButtonElement> });

  protected readonly path = computed(() => {
    const key = this.component().key;
    return key ? childPath(this.prefix(), key) : `${this.prefix()}#${this.index()}`;
  });
  protected readonly valuePath = computed<ValuePath>(() => [...this.container(), this.component().key ?? '']);
  protected readonly state = computed(() => this.store.evaluation().fields.get(this.path()));
  protected readonly visible = computed(() =>
    this.component().key ? this.state()?.visible === true : this.store.evaluation().display.get(this.path()) !== false,
  );
  protected readonly required = computed(() => this.state()?.required === true);
  protected readonly message = computed(() => (this.visible() ? this.store.messageFor(this.path(), this.component()) : null));
  protected readonly value = computed(() => this.store.valueAt(this.valuePath()));
  protected readonly text = computed(() => (typeof this.value() === 'string' ? (this.value() as string) : ''));
  protected readonly selected = computed(() => (Array.isArray(this.value()) ? (this.value() as readonly string[]) : []));
  protected readonly rows = computed(() => (Array.isArray(this.value()) ? (this.value() as readonly EditableObject[]) : []));
  protected readonly localDateTime = computed(() => toLocalInput(this.text()));
  protected readonly computedText = computed(() => display(this.state()?.computed));
  protected readonly canAddRow = computed(() => {
    const max = this.component().validate?.maxRows;
    return max === undefined || this.rows().length < max;
  });
  /** The hint, then the error, for the controls the form field component doesn't wrap (forms.md F3, "Accessibility"). */
  protected readonly describedBy = computed(() => [this.component().description ? this.hintId : null, this.message() ? this.errorId : null].filter((id) => id !== null).join(' ') || null);
  /** A file field (forms.md F3, "File fields"): the page's uploads, if it gives any, and its files and uploads, in order. */
  protected readonly uploads = inject(FILE_UPLOADS, { optional: true });
  protected readonly fileEntries = computed(() =>
    (Array.isArray(this.value()) ? (this.value() as readonly unknown[]) : []).flatMap((item): FileEntry[] => {
      const file = toFieldFile(item);
      if (file) {
        return [{ id: file.fileId, name: file.name, file }];
      }
      return isPendingUpload(item) ? [{ id: item.uploadId, name: item.name, file: null }] : [];
    }),
  );
  protected readonly accept = computed(() => this.component().validate?.accept?.join(',') ?? null);
  protected readonly uploadProblems = signal<readonly string[]>([]);

  constructor() {
    // The error summary links to the control that shows each path.
    effect((onCleanup) => {
      const path = this.path();
      const controlId = this.controlId();
      if (controlId && this.visible()) {
        this.store.registerControl(path, controlId);
        onCleanup(() => this.store.unregisterControl(path, controlId));
      }
    });
  }

  private controlId(): string | null {
    switch (this.component().type) {
      case 'heading':
      case 'paragraph':
      case 'separator':
      case 'group':
        return null;
      case 'checkbox':
      case 'file':
        return this.id;
      case 'radio':
      case 'checklist':
        return `${this.id}-0`;
      case 'dynamicList':
        return `${this.id}-add`;
      default:
        return this.field()?.controlId ?? null;
    }
  }

  protected sizeOf(file: FieldFile): string {
    return formatSize(Number(file.size));
  }

  /** Uploads each file chosen at once; a refusal shows under the field with the file's name. */
  protected chooseFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = Array.from(input.files ?? []);
    input.value = ''; // the same file can be chosen again
    this.uploadProblems.set([]);
    const uploads = this.uploads;
    if (!uploads) {
      return;
    }
    for (const file of chosen) {
      this.store.upload(this.valuePath(), this.path(), file, uploads, (text) =>
        this.uploadProblems.update((problems) => [...problems, `${file.name}: ${text}`]),
      );
    }
  }

  /** Takes a file off the field; nothing is deleted on the server (ADR-0014 §4.3). */
  protected removeFile(fileId: string): void {
    const items = Array.isArray(this.value()) ? (this.value() as readonly EditableObject[]) : [];
    this.update(items.filter((item) => toFieldFile(item)?.fileId !== fileId));
    this.focusFileInput();
  }

  protected cancelUpload(uploadId: string): void {
    this.store.cancelUpload(uploadId);
    this.focusFileInput();
  }

  private focusFileInput(): void {
    afterNextRender(() => this.host.querySelector<HTMLElement>(`#${this.id}`)?.focus(), { injector: this.injector });
  }

  protected update(value: EditableValue): void {
    this.store.setValue(this.valuePath(), this.path(), value);
  }

  protected updateDateTime(local: string): void {
    this.update(fromLocalInput(local));
  }

  protected toggle(option: string, checked: boolean): void {
    const chosen = new Set(this.selected());
    if (checked) {
      chosen.add(option);
    } else {
      chosen.delete(option);
    }
    // In option order, as the server lists them back.
    this.update((this.component().options ?? []).map((o) => o.value).filter((value) => chosen.has(value)));
  }

  protected touch(): void {
    this.store.touch(this.path());
  }

  protected rowPrefix(index: number): string {
    return rowPath(this.path(), index);
  }

  protected rowContainer(index: number): ValuePath {
    return [...this.valuePath(), index];
  }

  protected addRow(): void {
    this.store.addRow(this.valuePath(), this.component(), this.path());
    this.store.touch(this.path());
    afterNextRender(
      () => {
        const rows = this.host.querySelectorAll<HTMLElement>(`#${this.id} > .chain-form-list__row`);
        rows[rows.length - 1]?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
      },
      { injector: this.injector },
    );
  }

  protected removeRow(index: number): void {
    this.store.removeRow(this.valuePath(), index, this.path());
    this.store.touch(this.path());
    afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checkedOf(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}

/** A computed result as the page shows it (pt-BR). */
function display(value: ExprValue | undefined): string {
  switch (value?.kind) {
    case undefined:
    case 'missing':
      return '—';
    case 'number':
      return formatNumberInput(value.value);
    case 'boolean':
      return value.value ? 'Sim' : 'Não';
    case 'text':
      return value.value;
    case 'date': {
      const [year, month, day] = formatDate(value.day).split('-');
      return `${day}/${month}/${year}`;
    }
    case 'time':
      return formatTime(value.ticks);
    case 'datetime': {
      const [date, time] = toLocalInput(canonical(value)).split('T');
      const [year, month, day] = date.split('-');
      return time ? `${day}/${month}/${year} ${time}` : '—';
    }
    default:
      return '—';
  }
}
