import { CanDeactivateFn } from '@angular/router';
import { Observable } from 'rxjs';

/** A page that may hold unsaved work, and asks before it is left (workflow-editor.md §10.2). */
export interface CanLeave {
  canLeave(): boolean | Observable<boolean>;
}

/** Lets the router leave a page only when it says so. Kept apart from the page so the routes do not load it eagerly. */
export const leaveWhenSaved: CanDeactivateFn<CanLeave> = (page) => page.canLeave();
