import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';
import {
  LucideAlignLeft,
  LucideCalculator,
  LucideCalendar,
  LucideChevronDown,
  LucideCircleDot,
  LucideGroup,
  LucideHash,
  LucideHeading,
  LucideListChecks,
  LucideMinus,
  LucidePaperclip,
  LucidePilcrow,
  LucideRows3,
  LucideSquareCheck,
  LucideTextCursorInput,
} from '@lucide/angular';
import { PaletteType } from './form-edits';
import { PALETTE, PaletteEntry, TYPE_NAME } from './form-palette';

/**
 * The palette (form-designer.md §6): the entries in the POC's groups, each a button with its icon and name, and a search by
 * name and by type. A click or Enter on an entry asks the page to add it (§7.3).
 */
@Component({
  selector: 'chain-form-palette',
  imports: [
    LucideAlignLeft,
    LucideCalculator,
    LucideCalendar,
    LucideChevronDown,
    LucideCircleDot,
    LucideGroup,
    LucideHash,
    LucideHeading,
    LucideListChecks,
    LucideMinus,
    LucidePaperclip,
    LucidePilcrow,
    LucideRows3,
    LucideSquareCheck,
    LucideTextCursorInput,
  ],
  template: `
    <section class="chain-palette" aria-labelledby="chain-palette-title">
      <h2 id="chain-palette-title" class="chain-palette__title">Componentes</h2>
      <input
        class="chain-input chain-palette__search"
        type="search"
        aria-label="Pesquise componentes"
        placeholder="Pesquise componentes"
        [value]="search()"
        (input)="search.set(typed($event))"
      />
      @for (group of groups(); track group.name) {
        <h3 class="chain-palette__group" [id]="'chain-palette-' + $index">{{ group.name }}</h3>
        <ul class="chain-palette__list" [attr.aria-labelledby]="'chain-palette-' + $index">
          @for (entry of group.entries; track entry.type) {
            <li>
              <button type="button" class="chain-palette__entry" (click)="add.emit(entry.type)">
                @switch (entry.type) {
                  @case ('text') {
                    <svg lucideTextCursorInput aria-hidden="true"></svg>
                  }
                  @case ('textarea') {
                    <svg lucideAlignLeft aria-hidden="true"></svg>
                  }
                  @case ('number') {
                    <svg lucideHash aria-hidden="true"></svg>
                  }
                  @case ('date') {
                    <svg lucideCalendar aria-hidden="true"></svg>
                  }
                  @case ('computed') {
                    <svg lucideCalculator aria-hidden="true"></svg>
                  }
                  @case ('file') {
                    <svg lucidePaperclip aria-hidden="true"></svg>
                  }
                  @case ('checkbox') {
                    <svg lucideSquareCheck aria-hidden="true"></svg>
                  }
                  @case ('checklist') {
                    <svg lucideListChecks aria-hidden="true"></svg>
                  }
                  @case ('radio') {
                    <svg lucideCircleDot aria-hidden="true"></svg>
                  }
                  @case ('select') {
                    <svg lucideChevronDown aria-hidden="true"></svg>
                  }
                  @case ('heading') {
                    <svg lucideHeading aria-hidden="true"></svg>
                  }
                  @case ('paragraph') {
                    <svg lucidePilcrow aria-hidden="true"></svg>
                  }
                  @case ('separator') {
                    <svg lucideMinus aria-hidden="true"></svg>
                  }
                  @case ('group') {
                    <svg lucideGroup aria-hidden="true"></svg>
                  }
                  @case ('dynamicList') {
                    <svg lucideRows3 aria-hidden="true"></svg>
                  }
                }
                {{ entry.name }}
              </button>
            </li>
          }
        </ul>
      } @empty {
        <p class="chain-palette__none">Nenhum componente com esse nome.</p>
      }
    </section>
  `,
  styles: `
    .chain-palette {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-2);
    }

    .chain-palette__title {
      font-size: var(--chain-font-size-md);
    }

    .chain-palette__group {
      margin-block-start: var(--chain-space-2);
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-palette__list {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-palette__entry {
      display: flex;
      align-items: center;
      gap: var(--chain-space-2);
      inline-size: 100%;
      padding: var(--chain-space-1) var(--chain-space-2);
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-md);
      background: var(--color-bg-surface);
      color: var(--color-text);
      font: inherit;
      text-align: start;
      cursor: pointer;
    }

    .chain-palette__entry:hover {
      border-color: var(--color-border-control-hover);
    }

    .chain-palette__entry svg {
      flex: none;
      inline-size: 1rem;
      block-size: 1rem;
    }

    .chain-palette__none {
      color: var(--color-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormPalettePanel {
  /** The type of the entry chosen. */
  readonly add = output<PaletteType>();

  protected readonly search = signal('');
  /** The groups with the entries whose name or type contains the search, ignoring case and accents. */
  protected readonly groups = computed(() => {
    const wanted = fold(this.search().trim());
    const shown = PALETTE.filter((entry) => [entry.name, entry.type, TYPE_NAME[entry.type]].some((text) => fold(text).includes(wanted)));
    const names = [...new Set(shown.map((entry) => entry.group))];
    return names.map((name) => ({ name, entries: shown.filter((entry): entry is PaletteEntry => entry.group === name) }));
  });

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}
