import { headingNeighbour, sectionStartIndex } from '@shared/context';
import { computeDwell } from '@shared/timing';
import { extractWindow, type ReadingWindow } from '@shared/window';
import type { OverlayLayout, ParsedDocument, PlaybackStatus } from '@shared/types';
import type { PreferencesService } from './prefs';
import type { Store } from './store/db';

export interface SessionState {
  documentId: number | null;
  title: string;
  unitIndex: number;
  unitCount: number;
  status: PlaybackStatus;
  layout: OverlayLayout;
  /** Bumped whenever the main process seeks, so the renderer can resync. */
  revision: number;
}

/**
 * Authoritative reading state for the whole app (SPEC 11.5).
 *
 * The renderer runs the frame-accurate dwell clock, but this object owns the
 * document, the position, and the play/pause status so global shortcuts, menu
 * items and every layout act on the same state. Changing layout never touches
 * anything here, which is what keeps the playback clock intact.
 */
export class ReadingSession {
  private doc: ParsedDocument | null = null;
  private documentId: number | null = null;
  private index = 0;
  private status: PlaybackStatus = 'paused';
  private revision = 0;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private prefs: PreferencesService,
    private onChange: (state: SessionState, seeked: boolean) => void,
  ) {}

  state(layout: OverlayLayout): SessionState {
    return {
      documentId: this.documentId,
      title: this.doc?.title ?? '',
      unitIndex: this.index,
      unitCount: this.doc?.units.length ?? 0,
      status: this.status,
      layout,
      revision: this.revision,
    };
  }

  hasDocument(): boolean {
    return this.doc !== null;
  }

  currentDocumentId(): number | null {
    return this.documentId;
  }

  currentIndex(): number {
    return this.index;
  }

  /** Load a document, resuming its stored position unless told otherwise. */
  open(documentId: number, options: { resume?: boolean; startIndex?: number } = {}): boolean {
    if (this.documentId !== documentId) {
      const loaded = this.store.load(documentId);
      if (!loaded) return false;
      this.doc = loaded;
      this.documentId = documentId;
      /*
       * Timing is a live preference, not a property of the capture. A stored
       * document carries whatever dwell and rest values were current when it
       * was first parsed, so a document captured at 300 WPM would otherwise
       * replay at 300 WPM forever — and one captured before rests existed
       * would replay with none.
       */
      this.retime();
    }
    const summary = this.store.summary(documentId);
    const resumeIndex = options.resume === false ? 0 : (summary?.unitIndex ?? 0);
    this.index = this.clamp(options.startIndex ?? resumeIndex);
    this.revision++;
    this.status = 'paused';
    this.emit(true);
    return true;
  }

  close(): void {
    this.flushPosition();
    this.doc = null;
    this.documentId = null;
    this.index = 0;
    this.status = 'paused';
  }

  private clamp(index: number): number {
    const max = Math.max(0, (this.doc?.units.length ?? 1) - 1);
    return Math.min(Math.max(0, Math.round(index)), max);
  }

  private emit(seeked: boolean): void {
    this.onChange(this.state(this.prefs.all().layout), seeked);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.documentId === null) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushPosition(), 750);
  }

  flushPosition(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.documentId !== null) this.store.setPosition(this.documentId, this.index);
  }

  // ---------------------------------------------------------------- commands

  play(): void {
    if (!this.doc) return;
    this.status = 'playing';
    this.emit(false);
  }

  pause(): void {
    this.status = 'paused';
    this.emit(false);
  }

  togglePlay(): void {
    if (this.status === 'playing') this.pause();
    else this.play();
  }

  /** Report a position reached by the renderer's clock; does not re-seek it. */
  advanceTo(index: number, status?: PlaybackStatus): void {
    if (!this.doc) return;
    this.index = this.clamp(index);
    if (status) this.status = status;
    this.onChange(this.state(this.prefs.all().layout), false);
    this.schedulePersist();
  }

  step(delta: number): void {
    if (!this.doc) return;
    this.index = this.clamp(this.index + delta);
    this.revision++;
    this.emit(true);
  }

  seek(index: number): void {
    if (!this.doc) return;
    this.index = this.clamp(index);
    this.revision++;
    this.emit(true);
  }

  stepHeading(direction: -1 | 1): void {
    if (!this.doc) return;
    const target = headingNeighbour(this.doc, this.index, direction);
    if (target === null) return;
    this.seek(target);
  }

  restartSection(): void {
    if (!this.doc) return;
    this.seek(sectionStartIndex(this.doc, this.index));
  }

  adjustWpm(delta: number): number {
    const timing = this.prefs.all().timing;
    const next = this.prefs.update({ timing: { ...timing, wpm: timing.wpm + delta } }).timing.wpm;
    // Dwell times are baked into the document, so retime it in place.
    this.retime();
    return next;
  }

  /** Recompute dwell values in place after a timing preference change. */
  retime(): void {
    if (!this.doc) return;
    const settings = this.prefs.all().timing;
    // Only timing-derived fields change; unit identity and order are untouched,
    // so the reading position stays exactly where it was.
    let remaining = 0;
    const remainingMs = new Array<number>(this.doc.units.length + 1).fill(0);
    for (let i = this.doc.units.length - 1; i >= 0; i--) {
      const u = this.doc.units[i];
      const dwell = computeDwell(
        {
          kind: u.kind,
          visualLength: u.visualLength,
          boundary: u.boundary,
          parenthetical: u.parentheticalId !== null,
          entryRamp: u.entryRamp,
        },
        settings,
      );
      u.dwellMs = dwell.dwellMs;
      u.restMs = dwell.restMs;
      u.typeMultiplier = dwell.typeMultiplier;
      u.boundaryMultiplier = dwell.boundaryMultiplier;
      u.lengthFactor = dwell.lengthFactor;
      remaining += dwell.dwellMs + dwell.restMs;
      remainingMs[i] = remaining;
    }
    this.doc.remainingMs = remainingMs;
    this.doc.totalMs = remaining;
    this.revision++;
    this.emit(true);
  }

  /** Bounded window around the current position, for the renderer. */
  window(center = this.index): ReadingWindow | null {
    if (!this.doc || this.documentId === null) return null;
    return extractWindow(this.doc, this.documentId, this.clamp(center));
  }

  /** Unit index whose source range covers an offset, for Read-from-here. */
  unitIndexForSourceOffset(offset: number): number {
    if (!this.doc) return 0;
    const units = this.doc.units;
    let lo = 0;
    let hi = units.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (units[mid].range.start <= offset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
}
