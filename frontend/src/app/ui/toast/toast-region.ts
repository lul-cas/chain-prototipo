import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideX } from '@lucide/angular';
import { TONE_ICONS, TONE_LABEL } from '../alert/tone';
import { ToastService } from './toast.service';

/** Renders the toasts. Placed once, in the root component. */
@Component({
  selector: 'chain-toast-region',
  imports: [...TONE_ICONS, LucideX],
  template: `
    <section class="chain-toast-region" aria-label="Notificações">
      <div class="chain-toast-region__list" role="status">
        @for (toast of toasts.toasts(); track toast.id) {
          <div
            class="chain-toast"
            [attr.data-tone]="toast.tone"
            (mouseenter)="toasts.pause(toast.id)"
            (mouseleave)="toasts.resume(toast.id)"
            (focusin)="toasts.pause(toast.id)"
            (focusout)="toasts.resume(toast.id)"
          >
            <span class="chain-toast__icon">
              @switch (toast.tone) {
                @case ('success') { <svg lucideCircleCheck aria-hidden="true"></svg> }
                @case ('warning') { <svg lucideTriangleAlert aria-hidden="true"></svg> }
                @case ('danger') { <svg lucideCircleAlert aria-hidden="true"></svg> }
                @default { <svg lucideInfo aria-hidden="true"></svg> }
              }
            </span>
            <div class="chain-toast__content">
              <span class="chain-visually-hidden">{{ label[toast.tone] }} </span>
              @if (toast.title) {
                <p class="chain-toast__title">{{ toast.title }}</p>
              }
              <p>{{ toast.message }}</p>
            </div>
            <button type="button" class="chain-toast__close" (click)="toasts.dismiss(toast.id)">
              <svg lucideX aria-hidden="true"></svg>
              <span class="chain-visually-hidden">Fechar notificação</span>
            </button>
          </div>
        }
      </div>
    </section>
  `,
  styleUrl: './toast-region.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastRegion {
  protected readonly toasts = inject(ToastService);
  protected readonly label = TONE_LABEL;
}
