import { Directive, ElementRef, Injectable, computed, inject, input, signal } from '@angular/core';

/** The controls the server's last problems name, which the sections outline (automation-ui.md §8.2). The sections provide it. */
@Injectable()
export class ControlOutlines {
  private readonly source = signal<() => ReadonlySet<string>>(() => new Set());

  readonly paths = computed(() => this.source()());

  /** Outlines the controls this signal names. */
  follow(paths: () => ReadonlySet<string>): void {
    this.source.set(paths);
  }
}

/**
 * A control a problem can name (§8.2): its path, a focus target, and an outline while a problem names it. A drawn value takes
 * the focus only from code (`tabindex="-1"`); a form control keeps its own place in the tab order.
 */
@Directive({
  selector: '[chainControl]',
  host: {
    '[attr.data-control]': 'chainControl()',
    '[attr.tabindex]': 'native ? null : -1',
    '[class.chain-section__outlined]': 'outlines.paths().has(chainControl())',
  },
})
export class SectionControl {
  readonly chainControl = input.required<string>();
  protected readonly outlines = inject(ControlOutlines);
  protected readonly native = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.tagName);
}
