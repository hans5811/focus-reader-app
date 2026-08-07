import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@main/store/db';
import { PreferencesService } from '@main/prefs';
import { ReadingSession, type SessionState } from '@main/session';
import { buildStageSnapshot } from '@shared/context';
import { needsRefill, windowView } from '@shared/window';

const DOC = `# Sensor pipeline

## batch_ids replace run_labels

The rewrite touches services/ingest/models/station_registry.py and reads
station_record_id (inferred from the payload) before writing values.

Readings use Decimal(9, 3) so rounding stays predictable. That matters.

### Reverting

Run the down migration; it is reversible.
`;

describe('reading session state machine (SPEC 11.5)', () => {
  let dir: string;
  let store: Store;
  let prefs: PreferencesService;
  let session: ReadingSession;
  let states: SessionState[];
  let seeks: boolean[];
  let documentId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-session-'));
    store = new Store(dir);
    prefs = new PreferencesService(store);
    states = [];
    seeks = [];
    session = new ReadingSession(store, prefs, (state, seeked) => {
      states.push(state);
      seeks.push(seeked);
    });
    documentId = store.import({ content: DOC, source: 'clipboard' }).documentId;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens paused at the first unit and reports a seek', () => {
    expect(session.open(documentId)).toBe(true);
    expect(session.currentIndex()).toBe(0);
    expect(states.at(-1)!.status).toBe('paused');
    expect(seeks.at(-1)).toBe(true);
  });

  it('toggles between playing and paused', () => {
    session.open(documentId);
    session.togglePlay();
    expect(states.at(-1)!.status).toBe('playing');
    session.togglePlay();
    expect(states.at(-1)!.status).toBe('paused');
  });

  it('steps without ever changing unit order or leaving the document', () => {
    session.open(documentId);
    const count = states.at(-1)!.unitCount;
    session.step(1);
    session.step(1);
    expect(session.currentIndex()).toBe(2);
    session.step(-10);
    expect(session.currentIndex()).toBe(0);
    session.seek(count + 500);
    expect(session.currentIndex()).toBe(count - 1);
  });

  it('bumps the revision only on a real seek, not on clock advances', () => {
    session.open(documentId);
    const before = states.at(-1)!.revision;
    session.advanceTo(4, 'playing');
    expect(states.at(-1)!.revision).toBe(before);
    expect(seeks.at(-1)).toBe(false);
    session.step(1);
    expect(states.at(-1)!.revision).toBeGreaterThan(before);
    expect(seeks.at(-1)).toBe(true);
  });

  it('navigates by heading and restarts the current section', () => {
    session.open(documentId);
    const doc = store.load(documentId)!;
    const reverting = doc.headings.find((h) => h.text === 'Reverting')!;

    session.stepHeading(1);
    expect(session.currentIndex()).toBe(doc.headings[1].unitIndex);
    session.seek(reverting.unitIndex + 3);
    session.restartSection();
    expect(session.currentIndex()).toBe(reverting.unitIndex);

    session.stepHeading(-1);
    expect(session.currentIndex()).toBeLessThan(reverting.unitIndex);
  });

  it('persists and resumes the reading position', () => {
    session.open(documentId);
    session.seek(7);
    session.flushPosition();
    expect(store.summary(documentId)!.unitIndex).toBe(7);

    session.close();
    session.open(documentId);
    expect(session.currentIndex()).toBe(7);

    // An explicit restart ignores the stored position.
    session.open(documentId, { startIndex: 0 });
    expect(session.currentIndex()).toBe(0);
  });

  it('retimes in place without moving the reading position', () => {
    session.open(documentId);
    session.seek(6);
    const before = session.window()!;
    const beforeDwell = before.units[6 - before.start].dwellMs;

    session.adjustWpm(-150);
    expect(prefs.all().timing.wpm).toBe(150);
    expect(session.currentIndex()).toBe(6);

    const after = session.window()!;
    const afterDwell = after.units[6 - after.start].dwellMs;
    expect(afterDwell).toBeGreaterThan(beforeDwell);
    // Unit identity and order are untouched by a timing change.
    expect(after.units.map((u) => u.text)).toEqual(before.units.map((u) => u.text));
  });

  it('clamps WPM to the supported range', () => {
    session.open(documentId);
    session.adjustWpm(1000);
    expect(prefs.all().timing.wpm).toBe(700);
    session.adjustWpm(-1000);
    expect(prefs.all().timing.wpm).toBe(100);
  });

  it('maps a source offset back to the unit that covers it', () => {
    session.open(documentId);
    const offset = DOC.indexOf('station_record_id');
    const index = session.unitIndexForSourceOffset(offset);
    const doc = store.load(documentId)!;
    expect(doc.units[index].text).toBe('station_record_id');
  });

  it('serves a bounded window that still renders a correct stage', () => {
    session.open(documentId);
    session.seek(6);
    const win = session.window()!;
    expect(win.end - win.start).toBeLessThanOrEqual(win.unitCount);

    // The windowed view and a fully resident document agree.
    const fromWindow = buildStageSnapshot(windowView(win), documentId, 6);
    const fromDocument = buildStageSnapshot(store.load(documentId)!, documentId, 6);
    expect(fromWindow.unit).toEqual(fromDocument.unit);
    expect(fromWindow.wordsBefore).toEqual(fromDocument.wordsBefore);
    expect(fromWindow.wordsAfter).toEqual(fromDocument.wordsAfter);
    expect(fromWindow.previousSentence).toBe(fromDocument.previousSentence);
    expect(fromWindow.headingChain).toEqual(fromDocument.headingChain);
    expect(fromWindow.progress.markers).toEqual(fromDocument.progress.markers);
  });

  it('asks for a refill only near an edge it can still extend', () => {
    const big = store.import({
      content: Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' '),
      source: 'clipboard',
    }).documentId;
    session.open(big);
    session.seek(1500);

    const win = session.window()!;
    expect(needsRefill(win, 1500)).toBe(false);
    expect(needsRefill(win, win.end + 10)).toBe(true);
    expect(needsRefill(win, win.end - 5)).toBe(true);

    // At the very start of the document there is nothing more to fetch.
    session.seek(0);
    const atStart = session.window()!;
    expect(atStart.start).toBe(0);
    expect(needsRefill(atStart, 0)).toBe(false);
  });

  it('does nothing dangerous when no document is open', () => {
    expect(session.window()).toBeNull();
    expect(session.hasDocument()).toBe(false);
    expect(() => {
      session.play();
      session.step(3);
      session.stepHeading(1);
      session.restartSection();
      session.flushPosition();
    }).not.toThrow();
    expect(session.open(9999)).toBe(false);
  });
});
