import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

let nextId = 0;

/**
 * Chain's mark: two interlocked links, the ink link passing over the lighter one at the top
 * crossing and under it at the bottom (design-system.md §2.2). With `wordmark`, the name follows.
 */
@Component({
  selector: 'chain-brand-mark',
  template: `
    <svg class="chain-brand-mark__symbol" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <clipPath [attr.id]="clipId"><rect x="11" y="5" width="10" height="10" /></clipPath>
        <mask [attr.id]="maskId" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="white" />
          <g [attr.clip-path]="'url(#' + clipId + ')'">
            <rect x="2.75" y="9.75" width="16.5" height="12.5" rx="6.25" fill="none" stroke="black" stroke-width="6.5" />
          </g>
        </mask>
      </defs>
      <rect class="chain-brand-mark__ink" x="2.75" y="9.75" width="16.5" height="12.5" rx="6.25" fill="none" stroke-width="3.5" />
      <rect
        class="chain-brand-mark__link"
        x="12.75"
        y="9.75"
        width="16.5"
        height="12.5"
        rx="6.25"
        fill="none"
        stroke-width="3.5"
        [attr.mask]="'url(#' + maskId + ')'"
      />
    </svg>
    @if (wordmark()) {
      <span class="chain-brand-mark__word">chain</span>
    }
  `,
  styleUrl: './brand-mark.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMark {
  readonly wordmark = input(false, { transform: booleanAttribute });
  private readonly id = nextId++;
  protected readonly clipId = `chain-mark-clip-${this.id}`;
  protected readonly maskId = `chain-mark-mask-${this.id}`;
}
