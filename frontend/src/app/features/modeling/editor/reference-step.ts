import { Directive, OnInit, computed, input, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { CatalogEntry } from './conditions';
import { StepContract, StepMappings, readMappings, writeMappings } from './mappings';

/** What a step gives the panel on Aplicar: the reference to store, or that it can't be written yet. */
export type StepResult = { readonly reference: unknown } | { readonly incomplete: true };

/** A definition a step can reference: an automation, or a process. */
export interface ReferenceOption {
  readonly id: string;
  readonly name: string;
  /** Null until it is first published: the draft references it, and publishing reports it. */
  readonly latestVersion: number | null;
}

/**
 * What an automatic step and a sub-workflow step share (workflow-editor.md §10.9, §10.10): the definition they reference, by
 * name; its latest version's contract, which publishing pins; the mappings over it; and the reference to store, kept exactly as
 * stored while untouched. Choosing another definition drops the mappings.
 */
@Directive()
export abstract class ReferenceStep implements OnInit {
  /** The step's stored reference, or nothing. */
  readonly stored = input<unknown>(undefined);
  /** The data at the step (workflow-definition.md §6.5). */
  readonly catalog = input<readonly CatalogEntry[]>([]);

  /** The reference's id property: `automationId` or `workflowId`. */
  protected abstract readonly idField: 'automationId' | 'workflowId';
  protected abstract listOptions(): Observable<readonly ReferenceOption[]>;
  protected abstract readContractOf(id: string, version: number): Observable<StepContract>;

  protected readonly options = signal<readonly ReferenceOption[] | null>(null);
  protected readonly listFailed = signal(false);
  protected readonly chosenId = signal<string | null>(null);
  /** The latest version's contract: undefined while it is read, null when it can't be. */
  protected readonly contract = signal<StepContract | null | undefined>(undefined);
  protected readonly contractFailed = signal(false);
  protected readonly mappings = signal<StepMappings | null>(null);
  protected readonly chosen = computed(() => this.options()?.find((option) => option.id === this.chosenId()) ?? null);
  private touched = false;

  ngOnInit(): void {
    const stored = this.stored();
    const id = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>)[this.idField] : null;
    this.chosenId.set(typeof id === 'string' && id ? id : null);
    this.listOptions().subscribe({
      next: (options) => {
        this.options.set(options);
        this.readContract();
      },
      error: () => {
        this.options.set([]);
        this.listFailed.set(true);
      },
    });
  }

  /** The reference to store: as stored when nothing was touched; null with none chosen; incomplete while a row has an error. */
  result(): StepResult {
    if (!this.touched) {
      return { reference: this.stored() ?? null };
    }
    const id = this.chosenId();
    const mappings = this.mappings();
    if (!id || !mappings) {
      return { reference: id ? { [this.idField]: id } : null };
    }
    const written = writeMappings(mappings);
    if (!written) {
      return { incomplete: true };
    }
    return {
      reference: {
        [this.idField]: id,
        ...(Object.keys(written.inputs).length > 0 ? { inputs: written.inputs } : {}),
        ...(Object.keys(written.outputs).length > 0 ? { outputs: written.outputs } : {}),
      },
    };
  }

  protected choose(event: Event): void {
    this.touched = true;
    this.chosenId.set((event.target as HTMLSelectElement).value || null);
    this.mappings.set(null);
    this.readContract();
  }

  protected update(mappings: StepMappings): void {
    this.touched = true;
    this.mappings.set(mappings);
  }

  /** Reads the chosen definition's latest version, which publishing pins. */
  private readContract(): void {
    const option = this.chosen();
    this.contractFailed.set(false);
    this.contract.set(option && option.latestVersion !== null ? undefined : null);
    if (!option || option.latestVersion === null) {
      return;
    }
    this.readContractOf(option.id, option.latestVersion).subscribe({
      next: (contract) => {
        if (this.chosenId() === option.id) {
          this.contract.set(contract);
          this.mappings.set(readMappings(this.touched ? {} : this.stored(), contract));
        }
      },
      error: () => {
        this.contract.set(null);
        this.contractFailed.set(true);
      },
    });
  }
}
