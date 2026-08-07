import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { graphemes } from '@shared/text/segment';
import type { HeadingCrumb, ProgressModel, StageSnapshot, StageUnit } from '@shared/context';
import type { UnitKind } from '@shared/types';
import { fitFocusSize } from './measure';

export interface StageOptions {
  /** Hide optional elements per layout; never changes token or pivot logic. */
  showHeadings: boolean;
  showSentences: boolean;
  showWords: boolean;
  showProgress: boolean;
  showPivotHighlight: boolean;
  /** Base font size in px for the focused unit; measured down to fit the row. */
  focusSize: number;
  /** Floor the focused unit may shrink to before it wraps (SPEC 6.2). */
  minFocusSize: number;
  compactHeadings: boolean;
}

const TECHNICAL: Set<UnitKind> = new Set(['identifier', 'path', 'code-expression', 'declaration']);

function isTechnical(kind: UnitKind): boolean {
  return TECHNICAL.has(kind);
}

/**
 * Track the live pixel width of the word row.
 *
 * This is a *callback* ref rather than an effect over a ref object: the stage
 * renders an empty placeholder before the first snapshot arrives, so an effect
 * that runs once on mount would find no row, attach no observer, and leave the
 * width pinned at zero forever — which silently disables font fitting.
 */
function useMeasuredWidth(): [number, (node: HTMLElement | null) => void] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const attach = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    next.observe(node);
    observer.current = next;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [width, attach];
}

/** Split a unit's display text at the recognition pivot grapheme (SPEC 6.1). */
function splitAtPivot(unit: StageUnit): { pre: string; pivot: string; post: string } {
  const clusters = graphemes(unit.text);
  const at = Math.min(Math.max(unit.pivotIndex, 0), Math.max(0, clusters.length - 1));
  return {
    pre: clusters.slice(0, at).join(''),
    pivot: clusters[at] ?? '',
    post: clusters.slice(at + 1).join(''),
  };
}

/**
 * Render text with explicit break opportunities after path and identifier
 * separators.
 *
 * When a technical unit is already at its minimum size it has to wrap, and
 * SPEC 7.6 wants that wrap at a separator — `models/` — rather than in the
 * middle of a name. The `<wbr>` hints give the line breaker somewhere safe to
 * go; `overflow-wrap: anywhere` in CSS remains the last resort for a single
 * unbroken run.
 */
function Breakable({ text }: { text: string }): React.JSX.Element {
  const pieces = useMemo(() => text.split(/(?<=[/\\._-])/), [text]);
  if (pieces.length <= 1) return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) => (
        <Fragment key={i}>
          {piece}
          {i < pieces.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

const MARKER_LABELS: Record<string, string> = {
  bullet: 'list item',
  ordered: 'numbered item',
  'task-todo': 'task, not done',
  'task-done': 'task, done',
};

/** Spoken description for the live region; a glyph alone tells VoiceOver nothing. */
function describeUnit(unit: StageUnit): string {
  if (unit.marker) {
    const label = MARKER_LABELS[unit.marker] ?? 'list item';
    const depth = unit.listDepth ? `, level ${unit.listDepth}` : '';
    return unit.marker === 'ordered' ? `${unit.text} ${label}${depth}` : `${label}${depth}`;
  }
  return `${unit.text}, ${unit.kind.replace('-', ' ')}`;
}

function ContextWord({ unit, distance }: { unit: StageUnit; distance: number }): React.JSX.Element {
  return (
    <span
      className={[
        'ctx-word',
        isTechnical(unit.kind) ? 'is-technical' : '',
        unit.parenthetical ? 'is-parenthetical' : '',
        unit.marker ? 'is-marker' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // Opacity falls with distance from the focused unit (SPEC 5.6).
      style={{ opacity: Math.max(0.22, 0.66 - (distance - 1) * 0.14) }}
      aria-hidden="true"
    >
      {unit.text}
    </span>
  );
}

function HeadingStack({
  chain,
  compact,
}: {
  chain: HeadingCrumb[];
  compact: boolean;
}): React.JSX.Element | null {
  if (chain.length === 0) return null;

  // When space is tight, collapse middle ancestors but keep the root and the
  // active heading (SPEC 5.2, Docked Rail).
  const shown =
    compact && chain.length > 3
      ? [chain[0], { ...chain[1], text: '…', id: -1 }, chain[chain.length - 1]]
      : chain;

  return (
    <nav className="heading-stack" aria-label="Document section">
      {shown.map((crumb, i) => (
        <div
          key={`${crumb.id}-${i}`}
          className={`crumb level-${crumb.level} ${crumb.active ? 'is-active' : ''}`}
          style={{ paddingInlineStart: `${Math.min(i, 4) * 10}px` }}
          title={crumb.text}
          aria-current={crumb.active ? 'true' : undefined}
        >
          {/* Level is spelled out for assistive tech, never encoded by colour alone. */}
          <span className="crumb-level" aria-hidden="true">
            H{crumb.level}
          </span>
          <span className="crumb-text">{crumb.text}</span>
        </div>
      ))}
    </nav>
  );
}

function Progress({
  progress,
  onSeek,
}: {
  progress: ProgressModel;
  onSeek?: (index: number) => void;
}): React.JSX.Element {
  const pct = (value: number) => `${(value * 100).toFixed(3)}%`;
  const remaining = Math.round(progress.remainingMs / 1000);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <div className="progress">
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, progress.unitCount)}
        aria-valuenow={progress.unitIndex + 1}
        aria-valuetext={`Unit ${progress.unitIndex + 1} of ${progress.unitCount}`}
      >
        {/* The active section range, so the current heading's span is visible. */}
        {progress.hasHeadings && (
          <div
            className="progress-section"
            style={{
              left: pct(progress.sectionStart),
              width: pct(Math.max(0, progress.sectionEnd - progress.sectionStart)),
            }}
          />
        )}
        <div className="progress-fill" style={{ width: pct(progress.position) }} />
        {progress.markers.map((marker) => (
          <button
            key={marker.headingId}
            type="button"
            className={`progress-marker level-${marker.level} ${marker.active ? 'is-active' : ''}`}
            style={{ left: pct(marker.position) }}
            title={`H${marker.level} · ${marker.text}`}
            aria-label={`Jump to heading level ${marker.level}: ${marker.text}`}
            onClick={onSeek ? () => onSeek(marker.unitIndex) : undefined}
            tabIndex={-1}
          />
        ))}
      </div>
      <div className="progress-meta">
        <span>
          {progress.unitIndex + 1} / {progress.unitCount}
        </span>
        <span>
          {minutes}:{String(seconds).padStart(2, '0')} left
        </span>
      </div>
    </div>
  );
}

export interface ReadingStageProps {
  snapshot: StageSnapshot;
  options: StageOptions;
  /** True during the blank rest that follows a sentence (SPEC 8.6). */
  resting?: boolean;
  onSeek?: (index: number) => void;
}

/**
 * The single stage every layout renders (SPEC 5.1).
 *
 * The word row is a three-column grid whose middle column holds exactly the
 * pivot grapheme. Because the outer columns are equal fractions, the pivot sits
 * at the same screen coordinate no matter how long the word or its context is —
 * fixed placement comes from layout, not from colour or measurement.
 */
export function ReadingStage({
  snapshot,
  options,
  resting = false,
  onSeek,
}: ReadingStageProps): React.JSX.Element {
  const unit = snapshot.unit;
  const parts = useMemo(() => (unit ? splitAtPivot(unit) : null), [unit]);
  const [rowWidth, measureRow] = useMeasuredWidth();

  const fit = useMemo(
    () =>
      parts
        ? fitFocusSize(
            parts,
            unit ? isTechnical(unit.kind) : false,
            rowWidth,
            options.focusSize,
            options.minFocusSize,
          )
        : { size: options.focusSize, overflows: false },
    [parts, unit, rowWidth, options.focusSize, options.minFocusSize],
  );

  if (!unit || !parts) {
    return (
      <div className="stage is-empty">
        <p className="empty-hint">
          Nothing loaded. Press <kbd>⌃⌥D</kbd> to read the clipboard, or <kbd>⌃⌥A</kbd> for the
          latest agent response.
        </p>
      </div>
    );
  }

  const focusClasses = [
    'focus-word',
    isTechnical(unit.kind) ? 'is-technical' : 'is-prose',
    unit.parenthetical ? 'is-parenthetical' : '',
    unit.marker ? `is-marker marker-${unit.marker}` : '',
    `kind-${unit.kind}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="stage">
      {options.showHeadings && (
        <HeadingStack chain={snapshot.headingChain} compact={options.compactHeadings} />
      )}

      <div className="reading-area">
        {options.showSentences && (
          <div className="sentence-lane lane-previous" aria-hidden="true">
            {snapshot.previousSentence}
          </div>
        )}

        {/* The live region announces the focused unit, its type and position. */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {`${describeUnit(unit)}, unit ${snapshot.progress.unitIndex + 1} of ${snapshot.progress.unitCount}`}
        </div>

        {/* List depth is shown as structure, never inferred from indentation
            alone, so nesting survives at any layout size (SPEC 13). */}
        {unit.listDepth !== undefined && (
          <div className="list-depth" aria-hidden="true">
            {'·'.repeat(Math.min(unit.listDepth, 6))} list level {unit.listDepth}
          </div>
        )}

        {/*
          A unit too long for the row even at the minimum size is rendered as a
          single wrapping block. Splitting it across the fixed-pivot columns
          would let each half wrap independently, which scrambles reading order —
          keeping the run intact matters more than the pivot for this rare case.
        */}
        {fit.overflows ? (
          <div className="word-row is-overflowing" ref={measureRow} style={{ fontSize: `${fit.size}px` }}>
            <span className={`${focusClasses} focus-block`}>
              <Breakable text={parts.pre} />
              <span className={options.showPivotHighlight ? 'pivot-glyph is-highlighted' : 'pivot-glyph'}>
                {parts.pivot}
              </span>
              <Breakable text={parts.post} />
            </span>
          </div>
        ) : (
          <div
            className={`word-row${resting ? ' is-resting' : ''}`}
            ref={measureRow}
            style={{ fontSize: `${fit.size}px` }}
          >
            {/*
              The focus spans are keyed by unit index so React remounts them on
              every word, which is what restarts the entry fade. The row itself
              is deliberately *not* keyed: remounting it would tear down and
              rebuild the ResizeObserver several times a second and re-run font
              fitting from a zero width.
            */}
            <div className="lane lane-left">
              {options.showWords &&
                snapshot.wordsBefore.map((w, i) => (
                  <ContextWord key={w.index} unit={w} distance={snapshot.wordsBefore.length - i} />
                ))}
              <span key={unit.index} className={`${focusClasses} focus-pre`}>
                {parts.pre}
              </span>
            </div>

            <div className={`lane-pivot ${options.showPivotHighlight ? 'is-highlighted' : ''}`}>
              <span key={unit.index} className={focusClasses}>
                {parts.pivot}
              </span>
            </div>

            <div className="lane lane-right">
              <span key={unit.index} className={`${focusClasses} focus-post`}>
                {parts.post}
              </span>
              {options.showWords &&
                snapshot.wordsAfter.map((w, i) => (
                  <ContextWord key={w.index} unit={w} distance={i + 1} />
                ))}
            </div>
          </div>
        )}

        {snapshot.parenthetical && (
          <div className="parenthetical-lane" aria-label="Parenthetical aside">
            {snapshot.parenthetical}
          </div>
        )}

        {options.showSentences && (
          <div className="sentence-lane lane-next" aria-hidden="true">
            {snapshot.nextSentence}
          </div>
        )}
      </div>

      {options.showProgress && <Progress progress={snapshot.progress} onSeek={onSeek} />}
    </div>
  );
}
