import { InteractivityChecker } from '@angular/cdk/a11y';
import { Injectable, Provider } from '@angular/core';

/**
 * jsdom has no layout, so every element reports zero size and the CDK's focus trap considers it
 * invisible. This checker keeps all CDK rules (disabled, inert, tabindex) and only treats elements
 * as visible. Real visibility is exercised by the Playwright run in a browser.
 */
@Injectable()
class JsdomInteractivityChecker extends InteractivityChecker {
  override isVisible(): boolean {
    return true;
  }
}

export const provideJsdomInteractivity = (): Provider => ({
  provide: InteractivityChecker,
  useClass: JsdomInteractivityChecker,
});
