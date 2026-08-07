/** Unicode-aware segmentation helpers (SPEC 7.6). */

export interface Span {
  start: number;
  end: number;
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Split text into sentence spans using ICU sentence-break rules. */
export function segmentSentences(text: string): Span[] {
  const out: Span[] = [];
  for (const part of sentenceSegmenter.segment(text)) {
    const start = part.index;
    const end = start + part.segment.length;
    if (text.slice(start, end).trim().length === 0) continue;
    out.push({ start, end });
  }
  if (out.length === 0 && text.trim().length > 0) out.push({ start: 0, end: text.length });
  return out;
}

/**
 * Printable ASCII is one grapheme per code unit, which lets the hot paths skip
 * `Intl.Segmenter` entirely. Most reading units in a technical document qualify.
 */
const ASCII_ONLY = /^[\x20-\x7E]*$/;

export function isPlainAscii(text: string): boolean {
  return ASCII_ONLY.test(text);
}

/** Split into extended grapheme clusters, so emoji and combining marks count once. */
export function graphemes(text: string): string[] {
  if (ASCII_ONLY.test(text)) return text.split('');
  const out: string[] = [];
  for (const part of graphemeSegmenter.segment(text)) out.push(part.segment);
  return out;
}

export function graphemeCount(text: string): number {
  if (ASCII_ONLY.test(text)) return text.length;
  let n = 0;
  for (const _ of graphemeSegmenter.segment(text)) n++;
  return n;
}
