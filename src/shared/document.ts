import { PARSER_VERSION, parseBlocks, plainTextBlocks, type RawBlock } from './markdown/parse';
import { findProseParentheticals } from './text/parenthetical';
import { segmentSentences } from './text/segment';
import { tokenizeProse } from './text/tokenize';
import { recognizeToken, unitKindFor } from './text/technical';
import { resolveLanguage, tokenizeCode } from './code/highlight';
import { unitizeCodeLine } from './code/unitize';
import { pivotIndex } from './pivot';
import {
  ENTRY_RAMP_MULTIPLIER,
  TIMING_VERSION,
  computeDwell,
  sectionBoundaryFor,
  visualLength,
} from './timing';
import {
  DEFAULT_TIMING,
  type BoundaryKind,
  type DocumentBlock,
  type EntityAnnotation,
  type Heading,
  type ListMarkerKind,
  type ParentheticalSpan,
  type ParseOptions,
  type ParsedDocument,
  type ReadingUnit,
  type Sentence,
  type SourceRange,
  type TimingSettings,
  type UnitKind,
} from './types';

export const UNITIZER_VERSION = 'units/1';

/** Relative strength of boundary kinds, used when two boundaries coincide. */
const BOUNDARY_RANK: Record<BoundaryKind, number> = {
  none: 0,
  'code-line': 1,
  clause: 2,
  block: 3,
  sentence: 4,
  subsection: 5,
  'major-section': 6,
};

function stronger(a: BoundaryKind, b: BoundaryKind): BoundaryKind {
  return BOUNDARY_RANK[a] >= BOUNDARY_RANK[b] ? a : b;
}

/** A unit under construction, before timing is resolved. */
interface DraftUnit {
  text: string;
  kind: UnitKind;
  range: SourceRange;
  sentenceId: number | null;
  parentheticalId: number | null;
  headingStack: number[];
  blockId: number;
  boundary: BoundaryKind;
  entryRamp: number;
  code?: ReadingUnit['code'];
  marker?: ListMarkerKind;
  listDepth?: number;
}

class Builder {
  readonly drafts: DraftUnit[] = [];
  readonly headings: Heading[] = [];
  readonly sentences: Sentence[] = [];
  readonly parentheticals: ParentheticalSpan[] = [];
  readonly blocks: DocumentBlock[] = [];
  readonly entities: EntityAnnotation[] = [];

  /** Active heading ids by level (1-6), per SPEC 7.3. */
  private stack: (number | undefined)[] = [];
  /** Section boundary owed to the first content unit after a heading. */
  private pendingSection: BoundaryKind | null = null;
  /** Content units emitted since the last heading; drives the ramp (SPEC 8.4). */
  private sinceHeading = Number.MAX_SAFE_INTEGER;

  activeStack(): number[] {
    const out: number[] = [];
    for (let level = 1; level <= 6; level++) {
      const id = this.stack[level];
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  pushHeading(level: number, text: string, range: SourceRange): Heading {
    // Encountering level n clears n and deeper, then stores the new heading.
    for (let l = level; l <= 6; l++) this.stack[l] = undefined;
    const ancestors = this.activeStack();
    const heading: Heading = {
      id: this.headings.length,
      level: level as Heading['level'],
      text,
      range,
      unitIndex: this.drafts.length,
      ancestors,
    };
    this.headings.push(heading);
    this.stack[level] = heading.id;
    this.pendingSection = sectionBoundaryFor(level);
    this.sinceHeading = -1; // becomes 0 once the heading unit itself is emitted
    return heading;
  }

  add(draft: Omit<DraftUnit, 'headingStack' | 'entryRamp'>): number {
    const index = this.drafts.length;
    let boundary = draft.boundary;
    let entryRamp = 1;

    if (draft.kind === 'heading') {
      this.sinceHeading = 0;
    } else if (this.sinceHeading === 0) {
      if (this.pendingSection) boundary = stronger(boundary, this.pendingSection);
      this.pendingSection = null;
      this.sinceHeading = 1;
    } else if (this.sinceHeading === 1) {
      entryRamp = ENTRY_RAMP_MULTIPLIER;
      this.sinceHeading = 2;
    }

    this.drafts.push({
      ...draft,
      boundary,
      entryRamp,
      headingStack: this.activeStack(),
    });
    return index;
  }
}

function boundaryForToken(text: string): BoundaryKind {
  return /[,;]["'’”)\]]*$/.test(text) ? 'clause' : 'none';
}

function addProseBlock(
  block: RawBlock,
  builder: Builder,
  blockId: number,
  sentenceIdBase: () => number,
): void {
  const flat = block.flat;
  const text = flat.text;
  const hooks = {
    isAtomic: (i: number) => flat.isAtomic(i),
    atomicEnd: (i: number) => flat.atomicBounds(i)?.end ?? i,
  };

  const tokens = tokenizeProse(text, hooks);
  if (tokens.length === 0) return;

  const listDepth = block.kind === 'list-item' ? (block.depth ?? 1) : undefined;

  // The list marker leads the item as its own timed unit (SPEC 7.2). It belongs
  // to no sentence, so it never pollutes the same-sentence word context.
  if (block.marker) {
    builder.add({
      text: block.marker.text,
      kind: 'prose',
      range: block.marker.range,
      sentenceId: null,
      parentheticalId: null,
      blockId,
      boundary: 'none',
      marker: block.marker.kind,
      ...(listDepth !== undefined ? { listDepth } : {}),
    });
    builder.entities.push({
      kind: 'keyword',
      value: block.marker.text,
      range: block.marker.range,
      metadata: { listMarker: block.marker.kind, depth: listDepth ?? 1 },
    });
  }

  const sentenceSpans = segmentSentences(text);
  const proseSpans = findProseParentheticals(text, hooks.isAtomic);

  // Sentence and parenthetical ids are allocated lazily so only spans that
  // actually contain units are recorded.
  const sentenceIds = new Map<number, number>();
  const parentheticalIds = new Map<number, number>();
  const sentenceUnits = new Map<number, number[]>();
  const parentheticalUnits = new Map<number, number[]>();

  // Tokens and spans are both in increasing offset order and spans do not
  // overlap, so a monotonic cursor replaces what would otherwise be an O(n^2)
  // scan on documents with thousands of sentences.
  const cursors = { sentence: 0, parenthetical: 0 };
  const spanIndexAt = (
    spans: { start: number; end: number }[],
    offset: number,
    key: keyof typeof cursors,
  ): number => {
    while (cursors[key] < spans.length && spans[cursors[key]].end <= offset) cursors[key]++;
    const i = cursors[key];
    return i < spans.length && offset >= spans[i].start ? i : -1;
  };

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    const context = token.atomic ? 'code' : 'prose';
    const recognition = recognizeToken(token.text, context);
    const range = flat.sourceRange(token.start, token.end);

    let kind: UnitKind = 'prose';
    if (recognition) {
      kind = recognition.kind;
      builder.entities.push({
        kind: recognition.entity,
        value: token.text,
        range,
      });
    } else if (token.atomic) {
      // Inline code with no specific recognition is still a code expression.
      kind = 'code-expression';
    }

    const sIdx = spanIndexAt(sentenceSpans, token.start, 'sentence');
    let sentenceId: number | null = null;
    if (sIdx >= 0) {
      if (!sentenceIds.has(sIdx)) sentenceIds.set(sIdx, sentenceIdBase());
      sentenceId = sentenceIds.get(sIdx)!;
    }

    const pIdx = spanIndexAt(proseSpans, token.start, 'parenthetical');
    let parentheticalId: number | null = null;
    if (pIdx >= 0) {
      if (!parentheticalIds.has(pIdx)) parentheticalIds.set(pIdx, builder.parentheticals.length + parentheticalIds.size);
      parentheticalId = parentheticalIds.get(pIdx)!;
    }

    const isLastInBlock = t === tokens.length - 1;
    const endsSentence =
      sIdx >= 0 && (t === tokens.length - 1 || tokens[t + 1].start >= sentenceSpans[sIdx].end);

    let boundary: BoundaryKind = boundaryForToken(token.text);
    if (endsSentence) boundary = stronger(boundary, 'sentence');
    if (isLastInBlock) boundary = stronger(boundary, 'block');

    const index = builder.add({
      text: token.text,
      kind,
      range,
      sentenceId,
      parentheticalId,
      blockId,
      boundary,
      ...(listDepth !== undefined ? { listDepth } : {}),
    });

    if (sentenceId !== null) {
      if (!sentenceUnits.has(sentenceId)) sentenceUnits.set(sentenceId, []);
      sentenceUnits.get(sentenceId)!.push(index);
    }
    if (parentheticalId !== null) {
      if (!parentheticalUnits.has(parentheticalId)) parentheticalUnits.set(parentheticalId, []);
      parentheticalUnits.get(parentheticalId)!.push(index);
    }
  }

  for (const [spanIdx, id] of sentenceIds) {
    const indices = sentenceUnits.get(id) ?? [];
    if (indices.length === 0) continue;
    const span = sentenceSpans[spanIdx];
    builder.sentences.push({
      id,
      range: flat.sourceRange(span.start, span.end),
      text: text.slice(span.start, span.end).trim(),
      firstUnit: indices[0],
      lastUnit: indices[indices.length - 1],
      prevSentence: null,
      nextSentence: null,
    });
  }

  for (const [spanIdx, id] of parentheticalIds) {
    const indices = parentheticalUnits.get(id) ?? [];
    if (indices.length === 0) continue;
    const span = proseSpans[spanIdx];
    builder.parentheticals.push({
      id,
      range: flat.sourceRange(span.start, span.end),
      text: text.slice(span.start, span.end),
      firstUnit: indices[0],
      lastUnit: indices[indices.length - 1],
      depth: 0,
    });
  }
}

function addCodeBlock(
  block: RawBlock,
  builder: Builder,
  blockId: number,
  granularity: ParseOptions['codeGranularity'],
): void {
  const language = resolveLanguage(block.language);
  const lines = block.codeLines ?? [];
  const source = lines.map((l) => l.text).join('\n');
  const allTokens = tokenizeCode(source, language);

  let lineStart = 0;
  const pending: { line: (typeof lines)[number]; units: ReturnType<typeof unitizeCodeLine> }[] = [];

  for (const line of lines) {
    const lineEnd = lineStart + line.text.length;
    const lineTokens = allTokens
      .filter((t) => t.end > lineStart && t.start < lineEnd)
      .map((t) => ({
        type: t.type,
        start: Math.max(t.start, lineStart) - lineStart,
        end: Math.min(t.end, lineEnd) - lineStart,
      }));
    const units = unitizeCodeLine(line.text, lineTokens, granularity ?? 'lexical');
    if (units.length > 0) pending.push({ line, units });
    lineStart = lineEnd + 1;
  }

  for (let li = 0; li < pending.length; li++) {
    const { line, units } = pending[li];
    for (let ui = 0; ui < units.length; ui++) {
      const unit = units[ui];
      const range = {
        start: line.srcStart + unit.start,
        end: line.srcStart + unit.end,
      };
      const recognition = recognizeToken(unit.text, 'code', language || undefined);
      const kind: UnitKind = recognition ? unitKindFor(recognition.entity) : 'code-expression';
      if (recognition) {
        builder.entities.push({ kind: recognition.entity, value: unit.text, range });
      }

      const isLastOnLine = ui === units.length - 1;
      const isLastInBlock = isLastOnLine && li === pending.length - 1;
      let boundary: BoundaryKind = boundaryForToken(unit.text);
      if (isLastOnLine) boundary = stronger(boundary, 'code-line');
      if (isLastInBlock) boundary = stronger(boundary, 'block');

      builder.add({
        text: unit.text,
        kind,
        range,
        sentenceId: null,
        parentheticalId: null,
        blockId,
        boundary,
        code: { language: language || 'plain', line: line.line, tokens: unit.tokens },
      });
    }
  }
}

function deriveTitle(source: string, headings: Heading[], units: ReadingUnit[]): string {
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.text.trim();
  if (headings.length > 0) return headings[0].text.trim();
  const firstLine = source.split('\n').find((l) => l.trim().length > 0);
  if (firstLine) return firstLine.trim().slice(0, 120);
  return units.length > 0 ? units[0].text : 'Untitled document';
}

/**
 * Parse and unitize a document.
 *
 * The original `source` is stored verbatim and every unit carries an exact
 * source range, so nothing presented can drift from the input (SPEC 7.1).
 */
export function buildDocument(source: string, options: ParseOptions = {}): ParsedDocument {
  const settings: TimingSettings = { ...DEFAULT_TIMING, ...options.timing };
  const granularity = options.codeGranularity ?? 'lexical';

  let raw: RawBlock[];
  try {
    raw = parseBlocks(source);
  } catch {
    // SPEC 15: preserve and display the original as plain text.
    raw = plainTextBlocks(source);
  }

  const builder = new Builder();
  let nextSentenceId = 0;
  const allocSentenceId = () => nextSentenceId++;

  raw.forEach((block, blockId) => {
    const firstUnit = builder.drafts.length;

    if (block.kind === 'heading') {
      const text = block.flat.text.trim();
      const heading = builder.pushHeading(block.depth ?? 1, text, block.range);
      builder.add({
        text,
        kind: 'heading',
        range: block.flat.sourceRange(0, block.flat.length),
        sentenceId: null,
        parentheticalId: null,
        blockId,
        boundary: 'none',
      });
      heading.unitIndex = firstUnit;
    } else if (block.kind === 'code') {
      addCodeBlock(block, builder, blockId, granularity);
    } else if (block.kind !== 'thematic-break') {
      addProseBlock(block, builder, blockId, allocSentenceId);
    }

    const lastUnit = builder.drafts.length - 1;
    const entry: DocumentBlock = {
      id: blockId,
      kind: block.kind,
      range: block.range,
      firstUnit,
      lastUnit: Math.max(firstUnit, lastUnit),
    };
    if (block.language !== undefined) entry.language = block.language;
    if (block.depth !== undefined) entry.depth = block.depth;
    if (block.marker) entry.marker = { text: block.marker.text, kind: block.marker.kind };
    builder.blocks.push(entry);
  });

  // Resolve timing now that boundaries and ramps are final.
  const units: ReadingUnit[] = builder.drafts.map((draft, index) => {
    const visual = visualLength(draft.text);
    const dwell = computeDwell(
      {
        kind: draft.kind,
        visualLength: visual,
        boundary: draft.boundary,
        parenthetical: draft.parentheticalId !== null,
        entryRamp: draft.entryRamp,
      },
      settings,
    );
    return {
      index,
      text: draft.text,
      kind: draft.kind,
      range: draft.range,
      sentenceId: draft.sentenceId,
      parentheticalId: draft.parentheticalId,
      headingStack: draft.headingStack,
      blockId: draft.blockId,
      boundary: draft.boundary,
      entryRamp: draft.entryRamp,
      visualLength: visual,
      lengthFactor: dwell.lengthFactor,
      typeMultiplier: dwell.typeMultiplier,
      boundaryMultiplier: dwell.boundaryMultiplier,
      pivotIndex: pivotIndex(draft.text),
      dwellMs: dwell.dwellMs,
      restMs: dwell.restMs,
      ...(draft.code ? { code: draft.code } : {}),
      ...(draft.marker ? { marker: draft.marker } : {}),
      ...(draft.listDepth !== undefined ? { listDepth: draft.listDepth } : {}),
    };
  });

  // Link sentences in document order across block boundaries (SPEC 7.4).
  builder.sentences.sort((a, b) => a.firstUnit - b.firstUnit);
  builder.sentences.forEach((s, i) => {
    s.prevSentence = i > 0 ? builder.sentences[i - 1].id : null;
    s.nextSentence = i < builder.sentences.length - 1 ? builder.sentences[i + 1].id : null;
  });

  const remainingMs = new Array<number>(units.length + 1).fill(0);
  for (let i = units.length - 1; i >= 0; i--) {
    remainingMs[i] = remainingMs[i + 1] + units[i].dwellMs + units[i].restMs;
  }

  return {
    source,
    title: deriveTitle(source, builder.headings, units),
    hasHeadings: builder.headings.length > 0,
    units,
    headings: builder.headings,
    sentences: builder.sentences,
    parentheticals: builder.parentheticals,
    blocks: builder.blocks,
    entities: builder.entities,
    remainingMs,
    totalMs: remainingMs[0] ?? 0,
    parserVersion: PARSER_VERSION,
    unitizerVersion: UNITIZER_VERSION,
    timingVersion: TIMING_VERSION,
  };
}
