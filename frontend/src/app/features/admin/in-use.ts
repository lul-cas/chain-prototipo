import { ApiProblem } from '../../core/http/api-problem';

/** A published automation version a change would break, with the rules it would fail (automation.md §3.2, §4.2). */
export interface BrokenVersion {
  readonly automation: string;
  readonly version: number;
  readonly errors: readonly { readonly code: string; readonly message: string; readonly path: string | null }[];
}

/** What a 409 `destination_in_use` or `secret_in_use` names (automation-ui.md §1.1): only published versions count. */
export interface Usage {
  readonly secrets: readonly string[];
  readonly automations: readonly string[];
  readonly versions: readonly BrokenVersion[];
}

/** What uses an item, from the members of its 409. */
export function usageOf(problem: ApiProblem): Usage {
  const extensions = problem.extensions ?? {};
  const list = (name: string): string[] =>
    Array.isArray(extensions[name]) ? (extensions[name] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  const versions = Array.isArray(extensions['versions']) ? (extensions['versions'] as BrokenVersion[]) : [];
  return { secrets: list('secrets'), automations: list('automations'), versions };
}
