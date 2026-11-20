import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideMonitor, LucideMoon, LucideSun } from '@lucide/angular';
import { ThemePreference, ThemeService } from './theme.service';

let nextId = 0;

/** Segmented control for the theme preference, built on native radio buttons. */
@Component({
  selector: 'chain-theme-switch',
  imports: [LucideMonitor, LucideSun, LucideMoon],
  template: `
    <div class="chain-theme-switch" role="radiogroup" aria-label="Tema">
      @for (option of options; track option.value) {
        <input
          type="radio"
          class="chain-visually-hidden"
          [id]="name + '-' + option.value"
          [name]="name"
          [value]="option.value"
          [checked]="theme.preference() === option.value"
          (change)="theme.setPreference(option.value)"
        />
        <label [for]="name + '-' + option.value" [title]="option.label">
          @switch (option.value) {
            @case ('light') { <svg lucideSun aria-hidden="true"></svg> }
            @case ('dark') { <svg lucideMoon aria-hidden="true"></svg> }
            @default { <svg lucideMonitor aria-hidden="true"></svg> }
          }
          <span class="chain-theme-switch__text">{{ option.label }}</span>
        </label>
      }
    </div>
  `,
  styleUrl: './theme-switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThemeSwitch {
  protected readonly theme = inject(ThemeService);
  protected readonly name = `chain-theme-${nextId++}`;
  protected readonly options: readonly { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Sistema' },
    { value: 'light', label: 'Claro' },
    { value: 'dark', label: 'Escuro' },
  ];
}
