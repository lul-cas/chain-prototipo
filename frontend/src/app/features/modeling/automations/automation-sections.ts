import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AutomationIssue, AutomationResources } from '../automations-api';
import { controlFor, controlsOf } from './control-paths';
import { AutomationDocument } from './automation-document';
import { AutomationCall } from './automation-call';
import { AutomationExecution } from './automation-execution';
import { AutomationInputs } from './automation-inputs';
import { AutomationOutputs } from './automation-outputs';
import { callPreview } from './call-preview';
import { ControlOutlines } from './section-control';

/**
 * The automation's five sections, in the order of a call (automation-ui.md §7.1). *Entradas* is edited (AS4a); the others draw
 * the draft read-only until AS4b and AS5. Each value carries the `data-control` path its problems name (§8.2).
 */
@Component({
  selector: 'chain-automation-sections',
  imports: [AutomationCall, AutomationExecution, AutomationInputs, AutomationOutputs],
  providers: [ControlOutlines],
  template: `
    @let d = document();
    <div class="chain-sections">
      <div class="chain-sections__main">
        <chain-automation-inputs [document]="d" [published]="published()" />

        <chain-automation-call [document]="d" [resources]="resources()" />

        <chain-automation-outputs [document]="d" />

        <chain-automation-execution [document]="d" />
      </div>

      <section
        class="chain-section chain-sections__preview"
        aria-labelledby="chain-section-preview"
      >
        <h2 id="chain-section-preview">Prévia da chamada</h2>
        <pre
          class="chain-mono chain-section__preview"
          tabindex="0"
          aria-label="Prévia da chamada"
          >{{ preview() }}</pre>
        <p class="chain-section__muted">
          Uma ajuda de leitura: o servidor monta a chamada real quando a etapa roda.
        </p>
      </section>
    </div>
  `,
  styleUrl: './automation-sections.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationSections {
  readonly document = input.required<AutomationDocument>();
  readonly resources = input<AutomationResources | null>(null);
  /** The server's last problems; each outlines the control its path names (§8.2). */
  readonly problems = input<readonly AutomationIssue[]>([]);
  /** The input keys of the latest published version, for the rename warning (§7.2); null when none was published. */
  readonly published = input<ReadonlySet<string> | null>(null);
  readonly outlined = computed(() => {
    const controls = controlsOf(this.document());
    return new Set(this.problems().flatMap((problem) => controlFor(problem.path, controls) ?? []));
  });

  constructor() {
    inject(ControlOutlines).follow(this.outlined);
  }

  protected readonly destination = computed(
    () =>
      this.resources()?.destinations.find(
        (candidate) => candidate.name === this.document().request.destination,
      ) ?? null,
  );
  protected readonly preview = computed(() => callPreview(this.document(), this.destination()));
}
