/**
 * The color pairs Chain's components actually draw, with the WCAG 2.2 AA minimum each must meet.
 * contrast.spec.ts checks every pair in both themes. Adding a semantic color that is drawn as
 * text or as a UI boundary means adding its pairs here (specs/modules/design-system.md §3.4).
 *
 * - 4.5: text (WCAG 1.4.3, normal-size text).
 * - 3: non-text UI: control boundaries, focus indicators, icons that carry meaning (WCAG 1.4.11, 2.4.13).
 */
export interface ContrastPair {
  readonly fg: string;
  readonly bg: string;
  readonly min: 3 | 4.5;
  readonly use: string;
}

const surfaces = ['--color-bg-canvas', '--color-bg-surface', '--color-bg-subtle', '--color-bg-raised'] as const;
const interactiveSurfaces = [...surfaces, '--color-bg-hover', '--color-bg-selected'] as const;

const onEverySurface = (fg: string, min: 3 | 4.5, use: string, on: readonly string[] = surfaces): ContrastPair[] =>
  on.map((bg) => ({ fg, bg, min, use }));

const tones = ['info', 'success', 'warning', 'danger'] as const;
const nodeKinds = ['start', 'task', 'automatic', 'subworkflow', 'gateway', 'end', 'lane'] as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // Text
  ...onEverySurface('--color-text', 4.5, 'body text', interactiveSurfaces),
  ...onEverySurface('--color-text-muted', 4.5, 'secondary text, hints, placeholders', interactiveSurfaces),
  ...onEverySurface('--color-text-link', 4.5, 'links and the ink accent on text'),
  ...onEverySurface('--color-text-danger', 4.5, 'field error messages'),
  { fg: '--color-text-selected', bg: '--color-bg-selected', min: 4.5, use: 'selected navigation item' },
  { fg: '--color-text-inverse', bg: '--color-bg-inverse', min: 4.5, use: 'tooltips, inverse chips' },

  // Actions
  { fg: '--color-text-on-action', bg: '--color-action-primary', min: 4.5, use: 'primary button label' },
  { fg: '--color-text-on-action', bg: '--color-action-primary-hover', min: 4.5, use: 'primary button label, hover' },
  { fg: '--color-text-on-action', bg: '--color-action-primary-active', min: 4.5, use: 'primary button label, pressed' },
  { fg: '--color-text-on-danger', bg: '--color-action-danger', min: 4.5, use: 'danger button label' },
  { fg: '--color-text-on-danger', bg: '--color-action-danger-hover', min: 4.5, use: 'danger button label, hover' },
  ...onEverySurface('--color-action-primary', 3, 'primary button boundary against the page'),

  // Boundaries and focus
  ...onEverySurface('--color-border-control', 3, 'text field, checkbox and secondary button boundary'),
  ...onEverySurface('--color-border-danger', 3, 'invalid field boundary'),
  // The ring is always drawn with a 2px offset (base.css), so it sits on the surface around the
  // control, never on the control's own fill (a primary button and the ring share the ink hue).
  ...onEverySurface('--color-focus-ring', 3, 'focus indicator', interactiveSurfaces),

  // Status (alerts, toasts, badges): text and icon on the tinted background, icon on plain surfaces
  ...tones.flatMap((t) => [
    { fg: `--color-status-${t}-text`, bg: `--color-status-${t}-bg`, min: 4.5 as const, use: `${t} message text` },
    { fg: `--color-text`, bg: `--color-status-${t}-bg`, min: 4.5 as const, use: `${t} message body` },
    { fg: `--color-status-${t}-icon`, bg: `--color-status-${t}-bg`, min: 3 as const, use: `${t} icon on its tint` },
    ...onEverySurface(`--color-status-${t}-icon`, 3, `${t} icon or accent bar on a surface`),
  ]),

  // Workflow node kinds (editor, timeline, badges)
  ...nodeKinds.flatMap((k) => [
    { fg: `--color-node-${k}-fg`, bg: `--color-node-${k}-bg`, min: 4.5 as const, use: `${k} node label on its fill` },
    { fg: `--color-node-${k}-fg`, bg: '--color-bg-surface', min: 4.5 as const, use: `${k} node stroke and label on the canvas` },
    { fg: `--color-node-${k}-fg`, bg: '--color-bg-canvas', min: 4.5 as const, use: `${k} node stroke and label on the page` },
    { fg: '--color-handle', bg: `--color-node-${k}-bg`, min: 3 as const, use: `handle on the ${k} node fill` },
  ]),
  { fg: '--color-node-lane-band-fg', bg: '--color-node-lane-band', min: 4.5, use: 'lane title on the band' },
  ...onEverySurface('--color-node-lane-border', 3, 'lane boundary'),
  { fg: '--color-node-lane-border', bg: '--color-node-lane-bg', min: 3, use: 'lane boundary on the lane surface' },
  ...onEverySurface('--color-flow', 3, 'sequence flow'),
  ...onEverySurface('--color-flow-true', 4.5, 'true flow label'),
  ...onEverySurface('--color-flow-false', 4.5, 'false flow label'),
  ...onEverySurface('--color-handle', 3, 'connection handle'),
  ...onEverySurface('--color-selection', 3, 'selection outline', interactiveSurfaces),
];
