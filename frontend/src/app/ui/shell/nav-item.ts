import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A link in the shell's side navigation. Use with `routerLinkActive ariaCurrentWhenActive="page"`;
 * the current page is styled from `aria-current`, so what is announced and what is shown agree.
 */
@Component({
  selector: 'a[chainNavItem]',
  template: `<ng-content />`,
  styleUrl: './nav-item.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavItem {}
