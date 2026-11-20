import { INCIDENT_MESSAGES, incidentText } from './incident-messages';

/** Every code the engine opens an incident with. */
const KNOWN = [
  // An automatic gateway: a condition that does not parse, or an evaluation error (workflow-engine.md §13.2, expression-language.md §5.3).
  'invalid_condition',
  'type_mismatch',
  'division_by_zero',
  'empty_list',
  'invalid_number',
  'invalid_date',
  'overflow',
  // The loop guard (workflow-engine.md §13.2).
  'step_limit',
  // Sub-workflows (workflow-engine.md §14.2).
  'subprocess_input_invalid',
  'subprocess_output_invalid',
  'subprocess_faulted',
  'subprocess_cancelled',
  'depth_limit',
  // Automation steps (automation.md §6.4).
  'automation_input_invalid',
  'automation_unavailable',
  'automation_failed',
  'automation_output_invalid',
  'automation_timed_out',
];

describe('incidents in pt-BR (requests-ui.md §6)', () => {
  it.each(KNOWN)('%s has a text, a sentence of its own', (code) => {
    expect(incidentText(code)).toMatch(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ].*\.$/);
  });

  it('has texts for those codes only', () => {
    expect(Object.keys(INCIDENT_MESSAGES).sort()).toEqual([...KNOWN].sort());
  });

  it('gives each code its own text', () => {
    expect(new Set(Object.values(INCIDENT_MESSAGES)).size).toBe(KNOWN.length);
  });

  it('has no text for an unknown code, so the page shows the recorded message', () => {
    expect(incidentText('a_new_incident')).toBeNull();
    expect(incidentText('constructor')).toBeNull();
  });
});
