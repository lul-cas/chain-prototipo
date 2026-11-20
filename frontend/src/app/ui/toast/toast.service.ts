import { Injectable, signal } from '@angular/core';
import { Tone } from '../alert/tone';

export interface ToastOptions {
  readonly tone: Tone;
  readonly message: string;
  readonly title?: string;
}

export interface Toast extends ToastOptions {
  readonly id: number;
}

/** How long info and success toasts stay. Warning and danger stay until closed (WCAG 2.2.1). */
export const TOAST_DURATION_MS = 6000;

/**
 * Short, non-blocking feedback after an action (design-system.md §4.6). Toasts are announced
 * through the polite live region of ToastRegion; they never carry the only copy of an error that
 * the user must act on (that belongs next to the field or in an Alert on the page).
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly items = signal<readonly Toast[]>([]);
  readonly toasts = this.items.asReadonly();

  show(options: ToastOptions): number {
    const toast: Toast = { ...options, id: this.nextId++ };
    this.items.update((list) => [...list, toast]);
    this.resume(toast.id);
    return toast.id;
  }

  dismiss(id: number): void {
    this.pause(id);
    this.items.update((list) => list.filter((t) => t.id !== id));
  }

  /** Stops the auto-dismiss timer, for example while the pointer or focus is on the toast. */
  pause(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** Restarts the full auto-dismiss timer for a transient toast. */
  resume(id: number): void {
    const toast = this.items().find((t) => t.id === id);
    if (!toast || toast.tone === 'warning' || toast.tone === 'danger') {
      return;
    }
    this.pause(id);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), TOAST_DURATION_MS),
    );
  }
}
