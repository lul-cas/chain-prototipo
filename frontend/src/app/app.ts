import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './ui/theme/theme.service';
import { ToastRegion } from './ui/toast/toast-region';

@Component({
  selector: 'chain-root',
  imports: [RouterOutlet, ToastRegion],
  template: `
    <router-outlet />
    <chain-toast-region />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  constructor() {
    inject(ThemeService);
  }
}
