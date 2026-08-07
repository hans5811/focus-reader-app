/**
 * Domain types for the shared reading engine.
 *
 * Everything here is framework-independent (SPEC 11.1): no Electron, no React,
 * no filesystem. The same module is bundled into the main process, both
 * renderers, and the test runner.
 */

/** Half-open [start, end) offset pair into the *original* document source. */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * Coarse unit classification. This is what the timing model keys off
 * (SPEC 8.3); richer detail lives in {@link EntityAnnotation}.
 */
export type UnitKind =
  | 'prose'
  | 'heading'
  | 'identifier'
  | 'code-expression'
  | 'declaration'
  | 'path';

/** Boundary that *follows* a unit, used for the boundary multiplier (SPEC 8.3). */
export type BoundaryKind =
  | 'none'
  | 'clause'
  | 'sentence'
  | 'block'
  | 'code-line'
  | 'subsection'
  | 'major-section';

/** Fine-grained recognition result recorded against a source range (SPEC 7.5). */
export type EntityKind =
  | 'path'
  | 'filename'
  | 'identifier'
  | 'dotted-symbol'
  | 'call'
  | 'declaration'
  | 'type-annotation'
  | 'assignment'
  | 'shell-command'
  | 'flag'
  | 'env-var'
  | 'url'
  | 'uuid'
  | 'hash'
  | 'version'
  | 'database-object'
  | 'literal'
  | 'comment'
  | 'keyword';

export interface EntityAnnotation {
  kind: EntityKind;
  value: string;
  range: SourceRange;
  metadata?: Record<string, string | number>;
}

/**
 * What a list item's marker conveys (SPEC 7.2).
 *
 * The marker itself is never present in the item's prose — Markdown consumes it
 * — so it is synthesised as its own reading unit. Without this, ordered steps
 * lose their numbering and `- [x]` reads identically to `- [ ]`.
 */
export type ListMarkerKind = 'bullet' | 'ordered' | 'task-todo' | 'task-done';

export interface ListMarker {
  /** Text as displayed: the author's own "1." / "2)", or ☐ / ☑ / •. */
  text: string;
  kind: ListMarkerKind;
}

export interface Heading {
  id: number;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  range: SourceRange;
  /** Index of the heading's own reading unit. */
  unitIndex: number;
  /** Ancestor heading ids, outermost first, excluding this heading. */
  ancestors: number[];
}

export interface Sentence {
  id: number;
  range: SourceRange;
  text: string;
  /** Inclusive index of the first reading unit belonging to this sentence. */
  firstUnit: number;
  /** Inclusive index of the last reading unit belonging to this sentence. */
  lastUnit: number;
  prevSentence: number | null;
  nextSentence: number | null;
}

/** A balanced prose aside such as `(inferred from the payload)` (SPEC 5.7). */
export interface ParentheticalSpan {
  id: number;
  range: SourceRange;
  text: string;
  firstUnit: number;
  lastUnit: number;
  depth: number;
}

/** A syntax-highlighting token, carried alongside code units for rendering. */
export interface CodeToken {
  type: string;
  /** Offset relative to the start of the unit's display text. */
  start: number;
  end: number;
}

export interface CodeMetadata {
  language: string;
  /** 1-based line number within the fenced block. */
  line: number;
  tokens: CodeToken[];
}

export interface ReadingUnit {
  index: number;
  /** Text as displayed. May omit source delimiters such as backticks. */
  text: string;
  kind: UnitKind;
  /** Range in the original source. Always present, always exact (SPEC 16). */
  range: SourceRange;
  sentenceId: number | null;
  parentheticalId: number | null;
  /** Active heading ids, outermost first, deepest last (SPEC 7.3). */
  headingStack: number[];
  blockId: number;
  boundary: BoundaryKind;
  /** Section-entry ramp multiplier already resolved for this unit (SPEC 8.4). */
  entryRamp: number;
  visualLength: number;
  lengthFactor: number;
  typeMultiplier: number;
  boundaryMultiplier: number;
  /** Zero-based grapheme index of the optimal recognition position (SPEC 6.1). */
  pivotIndex: number;
  dwellMs: number;
  /** Blank rest shown after this unit before the next one appears (SPEC 8.6). */
  restMs: number;
  code?: CodeMetadata;
  /** Set when this unit *is* a synthesised list marker. */
  marker?: ListMarkerKind;
  /** 1-based list nesting depth, on every unit inside a list item. */
  listDepth?: number;
}

export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'list-item'
  | 'blockquote'
  | 'code'
  | 'table-cell'
  | 'thematic-break';

export interface DocumentBlock {
  id: number;
  kind: BlockKind;
  range: SourceRange;
  firstUnit: number;
  lastUnit: number;
  /** Fenced-code language, when known. */
  language?: string;
  /** List nesting depth / heading level, when meaningful. */
  depth?: number;
  /** Present on the first block of a list item, for Browse. */
  marker?: ListMarker;
}

/** Everything derived from one source document. */
export interface ParsedDocument {
  source: string;
  title: string;
  hasHeadings: boolean;
  units: ReadingUnit[];
  headings: Heading[];
  sentences: Sentence[];
  parentheticals: ParentheticalSpan[];
  blocks: DocumentBlock[];
  entities: EntityAnnotation[];
  /** Cumulative dwell in ms from each index to the end; length = units.length + 1. */
  remainingMs: number[];
  totalMs: number;
  parserVersion: string;
  unitizerVersion: string;
  timingVersion: string;
}

/** User-tunable timing and unitization settings (SPEC 8.5). */
export interface TimingSettings {
  /** 100–700. */
  wpm: number;
  /** 1.0–2.0x, applied to non-prose type multipliers. */
  technicalSlowdown: number;
  /** Multiplier applied on top of the heading type multiplier. */
  headingPause: number;
  /** Multiplier applied on top of the sentence boundary multiplier. */
  sentencePause: number;
  /** Multiplier applied on top of section-entry boundary multipliers. */
  sectionEntryPause: number;
  /**
   * 0–2x, scaling the blank rest inserted *after* a sentence ends. 0 disables
   * the rest entirely and restores continuous presentation.
   */
  sentenceBreak: number;
}

export const DEFAULT_TIMING: TimingSettings = {
  wpm: 300,
  technicalSlowdown: 1,
  headingPause: 1,
  sentencePause: 1,
  sectionEntryPause: 1,
  sentenceBreak: 1,
};

export type CodeGranularity = 'declaration' | 'lexical';

export interface ParseOptions {
  timing?: Partial<TimingSettings>;
  /** SPEC 7.6: declaration-sized units, or smaller lexical ones. */
  codeGranularity?: CodeGranularity;
}

/** The four persistent-plus-transient overlay layouts (SPEC 5.2). */
export type OverlayLayout = 'compact' | 'rail' | 'peek' | 'expanded';
export const PERSISTENT_LAYOUTS: OverlayLayout[] = ['compact', 'rail', 'expanded'];

export type PlaybackStatus = 'playing' | 'paused';
export type InteractionMode = 'focused' | 'passive' | 'click-through';

export interface DocumentSummary {
  id: number;
  title: string;
  source: CaptureSource;
  repository: string | null;
  sessionId: string | null;
  capturedAt: string;
  unitCount: number;
  unitIndex: number;
  read: boolean;
  byteLength: number;
}

export type CaptureSource = 'clipboard' | 'file' | 'claude-code' | 'codex';

/** Normalized hook envelope produced by `readerctl` (SPEC 10.2). */
export interface CaptureEnvelope {
  schema_version: 1;
  source: CaptureSource;
  source_version?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  model?: string;
  content: string;
  captured_at: string;
  source_metadata?: Record<string, unknown>;
}
