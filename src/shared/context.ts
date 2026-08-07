import type {
  CodeMetadata,
  Heading,
  ListMarkerKind,
  ParentheticalSpan,
  ParsedDocument,
  ReadingUnit,
  Sentence,
  UnitKind,
} from './types';

/**
 * The read-only surface the stage needs.
 *
 * A full {@link ParsedDocument} and a bounded window streamed to the renderer
 * both satisfy this, so context, progress and pivot logic exists exactly once
 * no matter how much of the document is resident (SPEC 5.1, 11.6).
 */
export interface DocumentView {
  title: string;
  unitCount: number;
  hasHeadings: boolean;
  totalMs: number;
  headings: Heading[];
  unitAt(index: number): ReadingUnit | null;
  sentenceById(id: number): Sentence | null;
  parentheticalById(id: number): ParentheticalSpan | null;
  remainingMsAt(index: number): number;
}

/** Adapt a fully resident document to the view interface. */
export function documentView(doc: ParsedDocument): DocumentView {
  const sentences = new Map(doc.sentences.map((s) => [s.id, s]));
  const parentheticals = new Map(doc.parentheticals.map((p) => [p.id, p]));
  return {
    title: doc.title,
    unitCount: doc.units.length,
    hasHeadings: doc.hasHeadings,
    totalMs: doc.totalMs,
    headings: doc.headings,
    unitAt: (i) => doc.units[i] ?? null,
    sentenceById: (id) => sentences.get(id) ?? null,
    parentheticalById: (id) => parentheticals.get(id) ?? null,
    remainingMsAt: (i) => doc.remainingMs[i] ?? 0,
  };
}

function asView(source: ParsedDocument | DocumentView): DocumentView {
  return 'units' in source ? documentView(source) : source;
}

/** A unit reduced to what the stage needs to render it. */
export interface StageUnit {
  index: number;
  text: string;
  kind: UnitKind;
  pivotIndex: number;
  parenthetical: boolean;
  code?: CodeMetadata;
  /** Set when this unit is a synthesised list marker (SPEC 7.2). */
  marker?: ListMarkerKind;
  /** 1-based list nesting depth, on every unit inside a list item. */
  listDepth?: number;
}

export interface HeadingCrumb {
  id: number;
  level: number;
  text: string;
  /** True for the deepest active heading, which is highlighted. */
  active: boolean;
}

export interface ProgressMarker {
  headingId: number;
  level: number;
  text: string;
  unitIndex: number;
  /** 0–1 along the progress track. */
  position: number;
  active: boolean;
}

export interface ProgressModel {
  unitIndex: number;
  unitCount: number;
  /** 0–1 overall completion. */
  position: number;
  markers: ProgressMarker[];
  /** Unit range of the active section, as 0–1 track positions. */
  sectionStart: number;
  sectionEnd: number;
  remainingMs: number;
  totalMs: number;
  hasHeadings: boolean;
}

export interface StageSnapshot {
  documentId: number;
  title: string;
  unit: StageUnit | null;
  /** Same-sentence words to the left of the pivot, in reading order. */
  wordsBefore: StageUnit[];
  /** Same-sentence words to the right of the pivot, in reading order. */
  wordsAfter: StageUnit[];
  previousSentence: string | null;
  nextSentence: string | null;
  headingChain: HeadingCrumb[];
  /** Secondary lane text for an active prose aside (SPEC 5.7). */
  parenthetical: string | null;
  progress: ProgressModel;
  dwellMs: number;
  /** Blank rest that follows this unit; 0 when it is not a sentence end. */
  restMs: number;
}

export interface ContextSettings {
  wordContext: boolean;
  sentenceContext: boolean;
  /** Up to this many same-sentence words on each side (SPEC 5.6). */
  wordContextCount: number;
  /** Visual truncation limit for adjacent sentences. */
  sentenceCharLimit: number;
}

export const DEFAULT_CONTEXT: ContextSettings = {
  wordContext: true,
  sentenceContext: true,
  wordContextCount: 3,
  sentenceCharLimit: 90,
};

function toStageUnit(unit: ReadingUnit): StageUnit {
  return {
    index: unit.index,
    text: unit.text,
    kind: unit.kind,
    pivotIndex: unit.pivotIndex,
    parenthetical: unit.parentheticalId !== null,
    ...(unit.code ? { code: unit.code } : {}),
    ...(unit.marker ? { marker: unit.marker } : {}),
    ...(unit.listDepth !== undefined ? { listDepth: unit.listDepth } : {}),
  };
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

export function buildHeadingChain(
  source: ParsedDocument | DocumentView,
  unit: ReadingUnit | null,
): HeadingCrumb[] {
  if (!unit) return [];
  const doc = asView(source);
  const chain: HeadingCrumb[] = [];
  unit.headingStack.forEach((id, i) => {
    const heading: Heading | undefined = doc.headings.find((h) => h.id === id);
    if (!heading) return;
    chain.push({
      id: heading.id,
      level: heading.level,
      text: heading.text,
      active: i === unit.headingStack.length - 1,
    });
  });
  return chain;
}

export function buildProgress(source: ParsedDocument | DocumentView, index: number): ProgressModel {
  const doc = asView(source);
  const unitCount = doc.unitCount;
  const clamped = Math.min(Math.max(index, 0), Math.max(0, unitCount - 1));
  const unit = doc.unitAt(clamped);
  const activeHeadingId = unit ? unit.headingStack[unit.headingStack.length - 1] : undefined;

  const markers: ProgressMarker[] = doc.headings.map((h) => ({
    headingId: h.id,
    level: h.level,
    text: h.text,
    unitIndex: h.unitIndex,
    position: unitCount > 0 ? h.unitIndex / unitCount : 0,
    active: h.id === activeHeadingId,
  }));

  let sectionStart = 0;
  let sectionEnd = unitCount;
  const active = doc.headings.find((h) => h.id === activeHeadingId);
  if (active) {
    sectionStart = active.unitIndex;
    const next = doc.headings.find((h) => h.unitIndex > active.unitIndex && h.level <= active.level);
    sectionEnd = next ? next.unitIndex : unitCount;
  }

  return {
    unitIndex: clamped,
    unitCount,
    position: unitCount > 0 ? clamped / unitCount : 0,
    markers,
    sectionStart: unitCount > 0 ? sectionStart / unitCount : 0,
    sectionEnd: unitCount > 0 ? sectionEnd / unitCount : 1,
    remainingMs: doc.remainingMsAt(clamped),
    totalMs: doc.totalMs,
    hasHeadings: doc.hasHeadings,
  };
}

/**
 * Build everything the ReadingStage renders for one position (SPEC 5.6).
 *
 * Word context is drawn only from the *same sentence* and stays on the word
 * row; adjacent sentences are separate vertical lanes. Neither may displace the
 * focused unit's pivot, which is the renderer's responsibility.
 */
export function buildStageSnapshot(
  source: ParsedDocument | DocumentView,
  documentId: number,
  index: number,
  settings: ContextSettings = DEFAULT_CONTEXT,
): StageSnapshot {
  const doc = asView(source);
  const progress = buildProgress(doc, index);
  const unit = doc.unitAt(progress.unitIndex);

  const snapshot: StageSnapshot = {
    documentId,
    title: doc.title,
    unit: unit ? toStageUnit(unit) : null,
    wordsBefore: [],
    wordsAfter: [],
    previousSentence: null,
    nextSentence: null,
    headingChain: buildHeadingChain(doc, unit),
    parenthetical: null,
    progress,
    dwellMs: unit?.dwellMs ?? 0,
    restMs: unit?.restMs ?? 0,
  };

  if (!unit) return snapshot;

  const sentence = unit.sentenceId !== null ? doc.sentenceById(unit.sentenceId) : null;

  if (settings.wordContext && sentence) {
    const from = Math.max(sentence.firstUnit, unit.index - settings.wordContextCount);
    const to = Math.min(sentence.lastUnit, unit.index + settings.wordContextCount);
    for (let i = from; i < unit.index; i++) {
      const u = doc.unitAt(i);
      if (u) snapshot.wordsBefore.push(toStageUnit(u));
    }
    for (let i = unit.index + 1; i <= to; i++) {
      const u = doc.unitAt(i);
      if (u) snapshot.wordsAfter.push(toStageUnit(u));
    }
  }

  if (settings.sentenceContext && sentence) {
    const prev = sentence.prevSentence !== null ? doc.sentenceById(sentence.prevSentence) : null;
    const next = sentence.nextSentence !== null ? doc.sentenceById(sentence.nextSentence) : null;
    if (prev) snapshot.previousSentence = truncate(prev.text, settings.sentenceCharLimit);
    if (next) snapshot.nextSentence = truncate(next.text, settings.sentenceCharLimit);
  }

  if (unit.parentheticalId !== null) {
    const span = doc.parentheticalById(unit.parentheticalId);
    if (span) snapshot.parenthetical = truncate(span.text, settings.sentenceCharLimit);
  }

  return snapshot;
}

/** Index of the first unit of the previous/next heading, for Option+arrow navigation. */
export function headingNeighbour(
  source: ParsedDocument | DocumentView,
  index: number,
  direction: -1 | 1,
): number | null {
  const doc = asView(source);
  if (doc.headings.length === 0) return null;
  if (direction === 1) {
    const next = doc.headings.find((h) => h.unitIndex > index);
    return next ? next.unitIndex : null;
  }
  // Step back past the current section's own heading when already sitting on it.
  const before = doc.headings.filter((h) => h.unitIndex < index);
  if (before.length === 0) return null;
  return before[before.length - 1].unitIndex;
}

/** Index of the heading that owns a unit, for Restart Section. */
export function sectionStartIndex(source: ParsedDocument | DocumentView, index: number): number {
  const doc = asView(source);
  const unit = doc.unitAt(index);
  if (!unit || unit.headingStack.length === 0) return 0;
  const id = unit.headingStack[unit.headingStack.length - 1];
  return doc.headings.find((h) => h.id === id)?.unitIndex ?? 0;
}
