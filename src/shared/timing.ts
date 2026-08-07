import { graphemes, isPlainAscii } from './text/segment';
import type { BoundaryKind, TimingSettings, UnitKind } from './types';

export const TIMING_VERSION = 'dwell/1';

export const MIN_DWELL_MS = 80;
export const MAX_DWELL_MS = 2500;

/** SPEC 8.3, unit-type multipliers. */
const TYPE_MULTIPLIER: Record<UnitKind, number> = {
  prose: 1.0,
  identifier: 1.15,
  'code-expression': 1.2,
  declaration: 1.25,
  path: 1.35,
  heading: 1.6,
};

/** SPEC 8.3, boundary multipliers. */
const BOUNDARY_MULTIPLIER: Record<BoundaryKind, number> = {
  none: 1.0,
  clause: 1.15,
  sentence: 1.45,
  block: 1.35,
  'code-line': 1.2,
  subsection: 1.45,
  'major-section': 1.7,
};

/** SPEC 5.7 / 8.3: prose inside a parenthetical aside. */
export const PARENTHETICAL_MULTIPLIER = 1.08;

/** SPEC 8.4: second content unit after a heading. */
export const ENTRY_RAMP_MULTIPLIER = 1.2;

const TECHNICAL_KINDS = new Set<UnitKind>([
  'identifier',
  'code-expression',
  'declaration',
  'path',
]);

const FULL_WIDTH =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;

/**
 * Visual length in grapheme clusters, weighted by how much space and attention
 * each cluster actually costs (SPEC 8.2).
 */
export function visualLength(text: string): number {
  let total = 0;

  // Fast path: printable ASCII needs no segmentation or Unicode property tests.
  if (isPlainAscii(text)) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9) total += 0.5;
      else if (c >= 65 && c <= 90) total += 1.05;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) total += 1.0;
      else total += 0.55;
    }
    return Math.round(total * 1000) / 1000;
  }

  for (const g of graphemes(text)) {
    if (FULL_WIDTH.test(g)) {
      total += 1.8;
    } else if (/\s/.test(g)) {
      total += 0.5;
    } else if (/\p{Lu}/u.test(g)) {
      total += 1.05;
    } else if (/[\p{L}\p{N}]/u.test(g)) {
      total += 1.0;
    } else {
      total += 0.55;
    }
  }
  return Math.round(total * 1000) / 1000;
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

/** SPEC 8.2. */
export function lengthFactor(visual: number): number {
  return clamp(1.0, 2.75, 1 + Math.max(0, visual - 8) * 0.035);
}

export function baseMilliseconds(wpm: number): number {
  return 60000 / clamp(100, 700, wpm);
}

export interface DwellInput {
  kind: UnitKind;
  visualLength: number;
  boundary: BoundaryKind;
  parenthetical: boolean;
  /** 1.0, or ENTRY_RAMP_MULTIPLIER for the second unit of a section. */
  entryRamp: number;
}

export interface DwellResult {
  lengthFactor: number;
  typeMultiplier: number;
  boundaryMultiplier: number;
  dwellMs: number;
}

/**
 * Resolve a unit's type multiplier, folding in the user's technical-slowdown
 * and heading-pause preferences. Slowdown scales the *excess* over 1.0 so a
 * setting of 1.0x reproduces the table exactly.
 */
export function typeMultiplierFor(
  kind: UnitKind,
  parenthetical: boolean,
  settings: TimingSettings,
): number {
  if (kind === 'heading') return TYPE_MULTIPLIER.heading * settings.headingPause;

  const base = TYPE_MULTIPLIER[kind];
  if (TECHNICAL_KINDS.has(kind)) {
    return 1 + (base - 1) * clamp(1, 2, settings.technicalSlowdown);
  }
  return parenthetical ? PARENTHETICAL_MULTIPLIER : base;
}

export function boundaryMultiplierFor(boundary: BoundaryKind, settings: TimingSettings): number {
  const base = BOUNDARY_MULTIPLIER[boundary];
  if (boundary === 'sentence') return base * settings.sentencePause;
  if (boundary === 'subsection' || boundary === 'major-section') {
    return base * settings.sectionEntryPause;
  }
  return base;
}

/** SPEC 8.5, final dwell. */
export function computeDwell(input: DwellInput, settings: TimingSettings): DwellResult {
  const lf = lengthFactor(input.visualLength);
  const tm = typeMultiplierFor(input.kind, input.parenthetical, settings);
  const bm = boundaryMultiplierFor(input.boundary, settings);
  const dwellMs = clamp(
    MIN_DWELL_MS,
    MAX_DWELL_MS,
    baseMilliseconds(settings.wpm) * lf * tm * bm * input.entryRamp,
  );
  return {
    lengthFactor: lf,
    typeMultiplier: tm,
    boundaryMultiplier: bm,
    dwellMs: Math.round(dwellMs),
  };
}

/** Section-entry boundary kind for a heading level (SPEC 8.3/8.4). */
export function sectionBoundaryFor(level: number): BoundaryKind {
  return level <= 2 ? 'major-section' : 'subsection';
}
