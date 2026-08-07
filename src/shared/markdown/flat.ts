import type { SourceRange } from '../types';

interface FlatPiece {
  flatStart: number;
  flatEnd: number;
  srcStart: number;
  srcEnd: number;
  /**
   * Atomic pieces (inline code) must never be split by the tokenizer, and their
   * interior offsets do not map linearly onto the source because the source
   * includes delimiters the display text omits.
   */
  atomic: boolean;
}

/**
 * A block's readable text with an exact map back to the original source.
 *
 * Markdown markup (`**`, `[]()`, backticks) is dropped from the flat text but
 * every surviving character still resolves to a source offset, which is what
 * lets every reading unit carry a true source range (SPEC 7.1).
 */
export class FlatText {
  text = '';
  private pieces: FlatPiece[] = [];

  append(text: string, srcStart: number, srcEnd: number, atomic = false): void {
    if (text.length === 0) return;
    this.pieces.push({
      flatStart: this.text.length,
      flatEnd: this.text.length + text.length,
      srcStart,
      srcEnd,
      atomic,
    });
    this.text += text;
  }

  /** Insert a separator that belongs to no source range (e.g. a soft break). */
  appendSeparator(text: string): void {
    if (text.length === 0 || this.text.length === 0) return;
    this.text += text;
  }

  get length(): number {
    return this.text.length;
  }

  private pieceAt(flatOffset: number): FlatPiece | undefined {
    // Pieces are appended in order, so a linear scan from a binary search point
    // is fine; documents are chunked per block and stay small.
    let lo = 0;
    let hi = this.pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = this.pieces[mid];
      if (flatOffset < p.flatStart) hi = mid - 1;
      else if (flatOffset >= p.flatEnd) lo = mid + 1;
      else return p;
    }
    return undefined;
  }

  /** True when the offset falls inside an inline-code region. */
  isAtomic(flatOffset: number): boolean {
    return this.pieceAt(flatOffset)?.atomic ?? false;
  }

  /** The atomic region containing this offset, as flat coordinates. */
  atomicBounds(flatOffset: number): { start: number; end: number } | null {
    const p = this.pieceAt(flatOffset);
    if (!p || !p.atomic) return null;
    return { start: p.flatStart, end: p.flatEnd };
  }

  /** Map a half-open flat range onto the smallest covering source range. */
  sourceRange(flatStart: number, flatEnd: number): SourceRange {
    const first = this.pieceAt(flatStart) ?? this.nearestPiece(flatStart);
    const last = this.pieceAt(Math.max(flatStart, flatEnd - 1)) ?? this.nearestPiece(flatEnd - 1);
    if (!first || !last) return { start: 0, end: 0 };
    const start = first.atomic ? first.srcStart : first.srcStart + (flatStart - first.flatStart);
    const end = last.atomic ? last.srcEnd : last.srcStart + (flatEnd - last.flatStart);
    return { start, end: Math.max(start, end) };
  }

  private nearestPiece(flatOffset: number): FlatPiece | undefined {
    let best: FlatPiece | undefined;
    for (const p of this.pieces) {
      if (p.flatStart <= flatOffset) best = p;
      else break;
    }
    return best ?? this.pieces[0];
  }
}
