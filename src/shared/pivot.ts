import { graphemes } from './text/segment';

export const PIVOT_VERSION = 'orp/1';

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u;

/**
 * Optimal recognition position by grapheme count (SPEC 6.1).
 *
 * | Length | Pivot |
 * |--------|-------|
 * | 1      | 0     |
 * | 2–5    | 1     |
 * | 6–9    | 2     |
 * | 10–13  | 3     |
 * | 14+    | ~30%  |
 */
export function pivotIndexForLength(count: number): number {
  if (count <= 1) return 0;
  if (count <= 5) return 1;
  if (count <= 9) return 2;
  if (count <= 13) return 3;
  return Math.min(count - 1, Math.round(count * 0.3));
}

/**
 * Pivot grapheme index within a unit's display text.
 *
 * Punctuation is excluded when choosing the linguistic pivot but stays in the
 * rendered unit, so the offset is measured on the core and shifted back by the
 * leading punctuation length.
 */
export function pivotIndex(text: string): number {
  const clusters = graphemes(text);
  if (clusters.length === 0) return 0;

  const lead = LEADING_PUNCTUATION.exec(text)?.[0] ?? '';
  const trail = TRAILING_PUNCTUATION.exec(text.slice(lead.length))?.[0] ?? '';
  const core = text.slice(lead.length, text.length - trail.length);
  if (core.length === 0) return pivotIndexForLength(clusters.length);

  const leadCount = graphemes(lead).length;
  const coreCount = graphemes(core).length;
  return Math.min(clusters.length - 1, leadCount + pivotIndexForLength(coreCount));
}
