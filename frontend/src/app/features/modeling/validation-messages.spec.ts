import { VALIDATION_MESSAGES, problemText } from './validation-messages';

const codes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `WF${String(from + i).padStart(3, '0')}`);

/** Every code workflow publishing can report: workflow-definition.md §2 (WF000–WF019), §5.3 (WF101–WF110) and §6.4 (WF201–WF210). */
const KNOWN = [...codes(0, 19), ...codes(101, 110), ...codes(201, 210)];

const problem = (code: string, message = 'The server says so.') => ({ code, message, elementId: null });

describe('validation problems in pt-BR (workflow-editor.md §10.1)', () => {
  it.each(KNOWN)('%s has a text, a sentence of its own', (code) => {
    const text = problemText(problem(code));

    expect(text).not.toBe('The server says so.');
    expect(text).toMatch(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ].*\.$/);
  });

  it('has texts for those codes only', () => {
    expect(Object.keys(VALIDATION_MESSAGES).sort()).toEqual([...KNOWN].sort());
  });

  it('gives each code its own text', () => {
    expect(new Set(Object.values(VALIDATION_MESSAGES)).size).toBe(KNOWN.length);
  });

  it("shows the server's message for a code without a text", () => {
    // WF999 stays unknown: no section of workflow-definition.md numbers its rules from 900.
    expect(problemText(problem('WF999', 'A rule the editor does not know yet.'))).toBe('A rule the editor does not know yet.');
    expect(problemText(problem('constructor', 'Not a rule.'))).toBe('Not a rule.');
  });
});
