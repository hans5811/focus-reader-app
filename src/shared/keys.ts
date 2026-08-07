/**
 * Keyboard-shortcut presentation, shared by the overlay and the Library.
 *
 * The focused-session keys are fixed by SPEC 5.9. The global ones are user
 * configurable, so the guide never hardcodes them — it renders whatever is
 * currently bound, which is also what makes it useful after a rebind.
 */

/** macOS modifier glyphs, in the conventional ⌃⌥⇧⌘ order. */
const MODIFIER_GLYPHS: [RegExp, string][] = [
  [/^(Control|Ctrl)$/i, '⌃'],
  [/^(Alt|Option|AltGr)$/i, '⌥'],
  [/^Shift$/i, '⇧'],
  [/^(Command|Cmd|Super|Meta|CommandOrControl|CmdOrCtrl)$/i, '⌘'],
];

const MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘'];

const KEY_GLYPHS: Record<string, string> = {
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  escape: 'Esc',
  esc: 'Esc',
  return: '↩',
  enter: '↩',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  plus: '+',
};

/**
 * Render an Electron accelerator as macOS key symbols.
 *
 * `Control+Alt+Shift+Left` becomes `⌃⌥⇧←`. Unknown keys pass through
 * unchanged so a custom binding is never shown as blank.
 */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  const modifiers: string[] = [];
  const keys: string[] = [];

  for (const part of parts) {
    const glyph = MODIFIER_GLYPHS.find(([re]) => re.test(part))?.[1];
    if (glyph) {
      if (!modifiers.includes(glyph)) modifiers.push(glyph);
      continue;
    }
    const lower = part.toLowerCase();
    keys.push(KEY_GLYPHS[lower] ?? (part.length === 1 ? part.toUpperCase() : part));
  }

  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers, ...keys].join('');
}

export interface GuideEntry {
  /** Pre-rendered key symbols, one chip per element. */
  keys: string[];
  description: string;
}

export interface GuideSection {
  title: string;
  note: string;
  entries: GuideEntry[];
}

/**
 * Focused-session keys (SPEC 5.9).
 *
 * These are bare keys and reach the app only while the overlay itself holds
 * keyboard focus, which is why they are safe to use and are not configurable.
 */
export const FOCUSED_KEYS: GuideEntry[] = [
  { keys: ['Space'], description: 'Play or pause' },
  { keys: ['←', '→'], description: 'Previous or next unit' },
  { keys: ['⌥←', '⌥→'], description: 'Previous or next heading' },
  { keys: ['↑', '↓'], description: 'Increase or decrease speed by 25 WPM' },
  { keys: ['R'], description: 'Restart the current section' },
  { keys: ['L'], description: 'Cycle overlay layout' },
  { keys: ['B'], description: 'Open Browse at the current position' },
  { keys: ['?'], description: 'Show this guide' },
  { keys: ['Esc'], description: 'Dismiss the overlay and restore the previous app' },
];

/** Display order and wording for the configurable global actions. */
export const GLOBAL_ACTION_LABELS: [string, string][] = [
  ['documentMode', 'Read the clipboard'],
  ['agentMode', 'Read the latest agent response'],
  ['toggleOverlay', 'Show or hide the overlay'],
  ['playPause', 'Play or pause'],
  ['prevUnit', 'Previous unit'],
  ['nextUnit', 'Next unit'],
  ['prevHeading', 'Previous heading'],
  ['nextHeading', 'Next heading'],
  ['peek', 'Peek at the current position'],
  ['toggleClickThrough', 'Toggle click-through'],
  ['cycleLayout', 'Cycle overlay layout'],
];

/** Build the global section from whatever is currently bound. */
export function globalEntries(shortcuts: Record<string, string>): GuideEntry[] {
  const entries: GuideEntry[] = [];
  for (const [action, description] of GLOBAL_ACTION_LABELS) {
    const accelerator = shortcuts[action];
    if (!accelerator) continue;
    entries.push({ keys: [formatAccelerator(accelerator)], description });
  }
  return entries;
}

export function buildGuide(shortcuts: Record<string, string>): GuideSection[] {
  return [
    {
      title: 'While the reader has focus',
      note: 'Available immediately after you summon the overlay — no click needed.',
      entries: FOCUSED_KEYS,
    },
    {
      title: 'From anywhere',
      note: 'These work while another app is in front. Every one is chorded on purpose, so plain Space and the arrow keys keep working in your editor and terminal.',
      entries: globalEntries(shortcuts),
    },
  ];
}
