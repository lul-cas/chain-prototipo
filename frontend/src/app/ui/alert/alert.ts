import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TONE_ICONS, TONE_LABEL, Tone } from './tone';

export type AlertTone = Tone;

/**
 * Inline message about the page or a form (design-system.md §4.4). Danger uses role="alert",
 * so an error that appears after an action is announced at once; the other tones use role="status".
 */
@Component({
  selector: 'chain-alert',
  imports: [...TONE_ICONS],
  template: `
    <span class="chain-alert__icon">
      @switch (tone()) {
        @case ('success') { <svg lucideCircleCheck aria-hidden="true"></svg> }
        @case ('warning') { <svg lucideTriangleAlert aria-hidden="true"></svg> }
        @case ('danger') { <svg lucideCircleAlert aria-hidden="true"></svg> }
        @default { <svg lucideInfo aria-hidden="true"></svg> }
      }
    </span>
    <div class="chain-alert__content">
      <span class="chain-visually-hidden">{{ toneLabel() }} </span>
      @if (title()) {
        <p class="chain-alert__title">{{ title() }}</p>
      }
      <div class="chain-alert__body"><ng-content /></div>
    </div>
  `,
  styleUrl: './alert.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.role]': 'tone() === "danger" ? "alert" : "status"',
    '[attr.data-tone]': 'tone()',
  },
})
export class Alert {
  readonly tone = input<AlertTone>('info');
  readonly title = input<string | null>(null);
  protected readonly toneLabel = computed(() => TONE_LABEL[this.tone()]);
}
