import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { LucideMenu, LucideX } from '@lucide/angular';
import { filter } from 'rxjs';

let nextId = 0;

/**
 * The application frame (design-system.md §5): skip link, top bar, side navigation and main
 * content. It is presentational: the caller projects the brand (`chainShellBrand`), the top-bar
 * actions (`chainShellActions`) and the navigation items (`chainShellNav`).
 * Below 64rem the navigation becomes a drawer opened by the menu button.
 */
@Component({
  selector: 'chain-shell',
  imports: [LucideMenu, LucideX],
  template: `
    <a class="chain-shell__skip" [href]="'#' + mainId" (click)="skipToContent($event)">Pular para o conteúdo</a>
    <header class="chain-shell__topbar">
      <button
        #menuButton
        type="button"
        class="chain-shell__menu"
        [attr.aria-expanded]="navOpen()"
        [attr.aria-controls]="navId"
        aria-label="Menu"
        (click)="navOpen.set(!navOpen())"
      >
        @if (navOpen()) {
          <svg lucideX aria-hidden="true"></svg>
        } @else {
          <svg lucideMenu aria-hidden="true"></svg>
        }
      </button>
      <div class="chain-shell__brand"><ng-content select="[chainShellBrand]" /></div>
      <div class="chain-shell__actions"><ng-content select="[chainShellActions]" /></div>
    </header>
    <div class="chain-shell__body">
      <nav
        #nav
        class="chain-shell__nav"
        [class.chain-shell__nav--open]="navOpen()"
        [id]="navId"
        aria-label="Principal"
      >
        <ng-content select="[chainShellNav]" />
      </nav>
      <main #main class="chain-shell__main" [id]="mainId" tabindex="-1">
        <ng-content />
      </main>
    </div>
  `,
  styleUrl: './shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  private readonly id = nextId++;
  protected readonly navId = `chain-shell-nav-${this.id}`;
  protected readonly mainId = `chain-shell-main-${this.id}`;
  protected readonly navOpen = signal(false);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private readonly menuButton = viewChild.required<ElementRef<HTMLButtonElement>>('menuButton');
  private readonly nav = viewChild.required<ElementRef<HTMLElement>>('nav');

  constructor() {
    const subscription = inject(Router)
      .events.pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.closeNav(false));
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    const nav = this.nav().nativeElement;
    if (event.target instanceof Node && nav.contains(event.target)) {
      this.closeNav(true);
    }
  }

  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.main().nativeElement.focus();
  }

  protected closeNav(returnFocus: boolean): void {
    if (!this.navOpen()) {
      return;
    }
    this.navOpen.set(false);
    if (returnFocus) {
      this.menuButton().nativeElement.focus();
    }
  }
}
