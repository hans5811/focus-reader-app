import type { DocumentView } from './context';
import type { Heading, ParentheticalSpan, ParsedDocument, ReadingUnit, Sentence } from './types';

/**
 * A bounded slice of a document, sized to be cheap to send over IPC.
 *
 * The renderer never holds a whole document (SPEC 11.6); it holds one of these
 * around the active position and asks for a new one as it nears an edge.
 */
export interface ReadingWindow {
  documentId: number;
  title: string;
  unitCount: number;
  totalMs: number;
  hasHeadings: boolean;
  /** Inclusive first index and exclusive last index of `units`. */
  start: number;
  end: number;
  units: ReadingUnit[];
  /** All headings: small, and needed for progress markers across the document. */
  headings: Heading[];
  sentences: Sentence[];
  parentheticals: ParentheticalSpan[];
  /** Remaining milliseconds, aligned so `remainingMs[i - start]` is index `i`. */
  remainingMs: number[];
}

export const DEFAULT_WINDOW_RADIUS = 300;
/** Refill once the position comes within this many units of an edge. */
export const WINDOW_REFILL_MARGIN = 60;

export function windowView(w: ReadingWindow): DocumentView {
  const sentences = new Map(w.sentences.map((s) => [s.id, s]));
  const parentheticals = new Map(w.parentheticals.map((p) => [p.id, p]));
  return {
    title: w.title,
    unitCount: w.unitCount,
    hasHeadings: w.hasHeadings,
    totalMs: w.totalMs,
    headings: w.headings,
    unitAt: (i) => (i >= w.start && i < w.end ? (w.units[i - w.start] ?? null) : null),
    sentenceById: (id) => sentences.get(id) ?? null,
    parentheticalById: (id) => parentheticals.get(id) ?? null,
    remainingMsAt: (i) => w.remainingMs[i - w.start] ?? 0,
  };
}

/** True when `index` is close enough to a window edge to need a refill. */
export function needsRefill(w: ReadingWindow, index: number): boolean {
  if (index < w.start || index >= w.end) return true;
  const atDocumentStart = w.start === 0;
  const atDocumentEnd = w.end >= w.unitCount;
  if (!atDocumentStart && index - w.start < WINDOW_REFILL_MARGIN) return true;
  if (!atDocumentEnd && w.end - index < WINDOW_REFILL_MARGIN) return true;
  return false;
}

/** Cut a window out of a fully resident document. */
export function extractWindow(
  doc: ParsedDocument,
  documentId: number,
  center: number,
  radius = DEFAULT_WINDOW_RADIUS,
): ReadingWindow {
  const start = Math.max(0, center - radius);
  const end = Math.min(doc.units.length, center + radius + 1);
  const units = doc.units.slice(start, end);

  // Include the sentences and spans referenced by the window, plus the
  // immediate neighbours the stage needs for its vertical lanes.
  const sentenceIds = new Set<number>();
  for (const u of units) if (u.sentenceId !== null) sentenceIds.add(u.sentenceId);
  for (const s of doc.sentences) {
    if (!sentenceIds.has(s.id)) continue;
    if (s.prevSentence !== null) sentenceIds.add(s.prevSentence);
    if (s.nextSentence !== null) sentenceIds.add(s.nextSentence);
  }

  const parentheticalIds = new Set<number>();
  for (const u of units) if (u.parentheticalId !== null) parentheticalIds.add(u.parentheticalId);

  return {
    documentId,
    title: doc.title,
    unitCount: doc.units.length,
    totalMs: doc.totalMs,
    hasHeadings: doc.hasHeadings,
    start,
    end,
    units,
    headings: doc.headings,
    sentences: doc.sentences.filter((s) => sentenceIds.has(s.id)),
    parentheticals: doc.parentheticals.filter((p) => parentheticalIds.has(p.id)),
    remainingMs: doc.remainingMs.slice(start, end),
  };
}
