/**
 * Text measurement for the reading stage.
 *
 * Sizing the focused unit from a character count is guesswork: proportional and
 * monospace faces differ, and the row width changes with the window. Measuring
 * the real glyph run against the real available width is what keeps a long unit
 * inside the row instead of overflowing or being crushed.
 */

const REFERENCE_SIZE = 100;

let canvasContext: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

function context2d(): CanvasRenderingContext2D | null {
  if (canvasContext) return canvasContext;
  const canvas = document.createElement('canvas');
  canvasContext = canvas.getContext('2d');
  return canvasContext;
}

/** Font stacks come from the stylesheet so they cannot drift from the CSS. */
export function fontStacks(): { prose: string; mono: string } {
  const styles = getComputedStyle(document.documentElement);
  return {
    prose: styles.getPropertyValue('--prose-font').trim() || 'system-ui, sans-serif',
    mono: styles.getPropertyValue('--mono-font').trim() || 'ui-monospace, monospace',
  };
}

/**
 * Width of `text` rendered at {@link REFERENCE_SIZE}px. Glyph advance scales
 * linearly with font size for a given face, so one measurement serves every
 * candidate size.
 */
export function widthAtReference(text: string, family: string, weight: number): number {
  if (text.length === 0) return 0;
  const key = `${weight}|${family}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const ctx = context2d();
  if (!ctx) return text.length * REFERENCE_SIZE * 0.55;
  ctx.font = `${weight} ${REFERENCE_SIZE}px ${family}`;
  const width = ctx.measureText(text).width;
  // Bounded so a long reading session cannot grow this without limit.
  if (cache.size > 4000) cache.clear();
  cache.set(key, width);
  return width;
}

export function widthAt(text: string, family: string, weight: number, size: number): number {
  return (widthAtReference(text, family, weight) * size) / REFERENCE_SIZE;
}

export interface FocusFit {
  size: number;
  /**
   * True when the unit cannot fit on the row even at the minimum size. The
   * stage then renders it as one wrapping block rather than dropping glyphs.
   */
  overflows: boolean;
}

/**
 * Largest font size at which both halves of the unit fit their side of the row.
 *
 * The pivot is pinned to the centre, so each half only gets half the row: the
 * binding constraint is the *longer* side, not the total length.
 */
export function fitFocusSize(
  parts: { pre: string; pivot: string; post: string },
  technical: boolean,
  rowWidth: number,
  maxSize: number,
  minSize: number,
): FocusFit {
  if (rowWidth <= 0) return { size: maxSize, overflows: false };

  const { prose, mono } = fontStacks();
  const family = technical ? mono : prose;
  const weight = technical ? 550 : 600;

  const pivotWidth = widthAt(parts.pivot, family, weight, maxSize);
  // Leave a little breathing room so glyphs never touch the window edge.
  const side = Math.max(24, (rowWidth - pivotWidth) / 2 - 12);

  const widest = Math.max(
    widthAtReference(parts.pre, family, weight),
    widthAtReference(parts.post, family, weight),
  );
  if (widest === 0) return { size: maxSize, overflows: false };

  const ideal = (side * REFERENCE_SIZE) / widest;
  if (ideal >= maxSize) return { size: maxSize, overflows: false };
  if (ideal >= minSize) return { size: ideal, overflows: false };
  return { size: minSize, overflows: true };
}
