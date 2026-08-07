import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument } from '@shared/document';
import { buildStageSnapshot, headingNeighbour, sectionStartIndex } from '@shared/context';
import { pivotIndex, pivotIndexForLength } from '@shared/pivot';
import { buildGuide, formatAccelerator } from '@shared/keys';
import { computeDwell, lengthFactor, visualLength } from '@shared/timing';
import { recognizeToken } from '@shared/text/technical';
import { tokenizeProse } from '@shared/text/tokenize';
import { findProseParentheticals } from '@shared/text/parenthetical';
import { DEFAULT_TIMING, type ParsedDocument } from '@shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = fs.readFileSync(path.join(here, 'fixtures/corpus.md'), 'utf8');

const textsOf = (doc: ParsedDocument) => doc.units.map((u) => u.text);
const find = (doc: ParsedDocument, text: string) => doc.units.find((u) => u.text === text);

describe('technical recognition (SPEC 7.5)', () => {
  it('recognizes the spec\u2019s canonical intact units', () => {
    expect(recognizeToken('station_record_id')?.entity).toBe('identifier');
    expect(recognizeToken('Decimal(9, 3)')?.entity).toBe('call');
    expect(recognizeToken('SensorReading(BaseModel):')?.entity).toBe('declaration');
    expect(recognizeToken('services/ingest/models/station_registry.py')?.entity).toBe('path');
  });

  it('recognizes paths, urls, versions, uuids, hashes, flags and env vars', () => {
    expect(recognizeToken('./scripts/build.sh')?.entity).toBe('path');
    expect(recognizeToken('~/Library/Preferences')?.entity).toBe('path');
    expect(recognizeToken('C:\\Users\\dev\\app.ts')?.entity).toBe('path');
    expect(recognizeToken('src/main.ts')?.entity).toBe('path');
    expect(recognizeToken('https://example.com/docs')?.entity).toBe('url');
    expect(recognizeToken('2.11.0')?.entity).toBe('version');
    expect(recognizeToken('a3f1c2d4-5b6e-7a89-0c1d-2e3f4a5b6c7d')?.entity).toBe('uuid');
    expect(recognizeToken('9f3ac1b')?.entity).toBe('hash');
    expect(recognizeToken('--dry-run')?.entity).toBe('flag');
    expect(recognizeToken('$POSTGRES_URL')?.entity).toBe('env-var');
    expect(recognizeToken('SensorReading')?.entity).toBe('identifier');
    expect(recognizeToken('stationRecordId')?.entity).toBe('identifier');
  });

  it('leaves ordinary prose alone', () => {
    for (const word of ['the', 'Readings', 'and/or', 'e.g.', 'i.e.', 'don\u2019t', 'AWS', 'OK', 'schema.']) {
      expect(recognizeToken(word), word).toBeNull();
    }
  });

  it('keeps trailing sentence punctuation out of the classification', () => {
    expect(recognizeToken('station_record_id.')?.entity).toBe('identifier');
    expect(recognizeToken('src/main.ts,')?.entity).toBe('path');
  });
});

describe('prose tokenization (SPEC 7.6)', () => {
  it('rejoins a call expression split across whitespace', () => {
    const tokens = tokenizeProse('Readings use Decimal(9, 3) so rounding works.');
    expect(tokens.map((t) => t.text)).toContain('Decimal(9, 3)');
  });

  it('does not merge a prose aside into one token', () => {
    const tokens = tokenizeProse('the state (inferred from the payload) is stored');
    expect(tokens.map((t) => t.text)).toEqual([
      'the', 'state', '(inferred', 'from', 'the', 'payload)', 'is', 'stored',
    ]);
  });

  it('keeps contractions, decimals and versions intact', () => {
    const tokens = tokenizeProse("don't use 3.14 or v2.11.0 here");
    expect(tokens.map((t) => t.text)).toEqual(["don't", 'use', '3.14', 'or', 'v2.11.0', 'here']);
  });
});

describe('parenthetical spans (SPEC 5.7)', () => {
  it('finds a balanced prose aside', () => {
    const text = 'the state (inferred from the payload) is stored';
    expect(findProseParentheticals(text)).toEqual([{ start: 10, end: 37 }]);
  });

  it('ignores technical delimiters', () => {
    expect(findProseParentheticals('Readings use Decimal(9, 3) here')).toEqual([]);
  });

  it('collapses nesting to the outermost span', () => {
    const text = 'asides (such as this (inner) one) collapse';
    expect(findProseParentheticals(text)).toEqual([{ start: 7, end: 33 }]);
    expect(text.slice(7, 33)).toBe('(such as this (inner) one)');
  });

  it('degrades safely on unmatched parentheses', () => {
    expect(findProseParentheticals('Unmatched parentheses (like this one degrade')).toEqual([]);
  });
});

describe('recognition pivot (SPEC 6.1)', () => {
  it('follows the documented table', () => {
    expect(pivotIndexForLength(1)).toBe(0);
    for (const n of [2, 3, 4, 5]) expect(pivotIndexForLength(n)).toBe(1);
    for (const n of [6, 7, 8, 9]) expect(pivotIndexForLength(n)).toBe(2);
    for (const n of [10, 11, 12, 13]) expect(pivotIndexForLength(n)).toBe(3);
    expect(pivotIndexForLength(20)).toBe(6);
    expect(pivotIndexForLength(40)).toBe(12);
  });

  it('excludes leading and trailing punctuation from the linguistic pivot', () => {
    expect(pivotIndex('word')).toBe(pivotIndex('word.'));
    expect(pivotIndex('(word)')).toBe(pivotIndex('word') + 1);
  });

  it('counts graphemes, not code units', () => {
    expect(pivotIndex('👨‍👩‍👧‍👦')).toBe(0);
    expect(pivotIndex('café')).toBe(1);
  });
});

describe('timing model (SPEC 8)', () => {
  it('weights visual length by grapheme class', () => {
    expect(visualLength('abc')).toBe(3);
    expect(visualLength('ABC')).toBeCloseTo(3.15, 5);
    expect(visualLength('a_b')).toBeCloseTo(2.55, 5);
    expect(visualLength('日本')).toBeCloseTo(3.6, 5);
  });

  it('clamps the length factor to the documented range', () => {
    expect(lengthFactor(4)).toBe(1);
    expect(lengthFactor(8)).toBe(1);
    expect(lengthFactor(18)).toBeCloseTo(1.35, 5);
    expect(lengthFactor(1000)).toBe(2.75);
  });

  it('gives the long path 500-800ms at 300 WPM (SPEC 8.5 calibration)', () => {
    const dwell = computeDwell(
      {
        kind: 'path',
        visualLength: visualLength('services/ingest/models/station_registry.py'),
        boundary: 'none',
        parenthetical: false,
        entryRamp: 1,
      },
      DEFAULT_TIMING,
    );
    expect(dwell.dwellMs).toBeGreaterThanOrEqual(500);
    expect(dwell.dwellMs).toBeLessThanOrEqual(800);
  });

  it('gives a long path materially more time than a short prose word', () => {
    const doc = buildDocument(CORPUS);
    const long = find(doc, 'services/ingest/models/station_registry.py');
    const short = doc.units.find((u) => u.kind === 'prose' && u.text === 'The');
    expect(long).toBeDefined();
    expect(short).toBeDefined();
    expect(long!.dwellMs).toBeGreaterThan(short!.dwellMs * 2);
  });

  it('clamps every dwell into [80, 2500]', () => {
    const doc = buildDocument(CORPUS);
    for (const u of doc.units) {
      expect(u.dwellMs).toBeGreaterThanOrEqual(80);
      expect(u.dwellMs).toBeLessThanOrEqual(2500);
    }
  });
});

describe('document pipeline (SPEC 7)', () => {
  const doc = buildDocument(CORPUS);

  it('preserves the source byte-for-byte', () => {
    expect(doc.source).toBe(CORPUS);
  });

  it('maps every unit back to a source range (SPEC 16)', () => {
    for (const u of doc.units) {
      expect(u.range.end).toBeGreaterThan(u.range.start);
      expect(u.range.end).toBeLessThanOrEqual(CORPUS.length);
    }
  });

  it('keeps the spec\u2019s canonical units intact', () => {
    const texts = textsOf(doc);
    expect(texts).toContain('station_record_id');
    expect(texts).toContain('Decimal(9, 3)');
    expect(texts).toContain('services/ingest/models/station_registry.py');
    expect(texts).toContain('SensorReading(BaseModel):');
  });

  it('never splits a path into directory units', () => {
    // Segments that exist only inside the path, so a hit means it was split.
    expect(textsOf(doc)).not.toContain('models');
    expect(textsOf(doc)).not.toContain('station_registry.py');
  });

  it('builds the H1-H6 stack with correct ancestor chains (SPEC 7.3)', () => {
    const deepest = doc.headings.find((h) => h.level === 6);
    expect(deepest).toBeDefined();
    const chain = deepest!.ancestors.map((id) => doc.headings[id].level);
    expect(chain).toEqual([1, 2, 3, 4, 5]);
  });

  it('clears deeper headings when a shallower one appears', () => {
    const interfaces = doc.headings.find((h) => h.text === 'Interfaces');
    expect(interfaces?.level).toBe(2);
    expect(interfaces!.ancestors.map((id) => doc.headings[id].text)).toEqual([
      'Sensor pipeline: unified readings schema',
    ]);
  });

  it('updates heading context before the first unit of a new section', () => {
    const heading = doc.headings.find((h) => h.text === 'Interfaces')!;
    const headingUnit = doc.units[heading.unitIndex];
    expect(headingUnit.kind).toBe('heading');
    expect(headingUnit.headingStack.at(-1)).toBe(heading.id);
    expect(doc.units[heading.unitIndex + 1].headingStack.at(-1)).toBe(heading.id);
  });

  it('applies the section-entry ramp (SPEC 8.4)', () => {
    const heading = doc.headings.find((h) => h.text === 'Interfaces')!;
    expect(doc.units[heading.unitIndex].kind).toBe('heading');
    expect(['subsection', 'major-section']).toContain(doc.units[heading.unitIndex + 1].boundary);
    expect(doc.units[heading.unitIndex + 2].entryRamp).toBeCloseTo(1.2, 5);
    expect(doc.units[heading.unitIndex + 3].entryRamp).toBe(1);
  });

  it('marks prose asides across every unit in the span', () => {
    const derived = find(doc, '(inferred');
    expect(derived?.parentheticalId).not.toBeNull();
    const span = doc.parentheticals.find((p) => p.id === derived!.parentheticalId)!;
    const covered = doc.units.slice(span.firstUnit, span.lastUnit + 1).map((u) => u.text);
    expect(covered).toEqual(['(inferred', 'from', 'the', 'payload)']);
    expect(covered.every((_, i) => doc.units[span.firstUnit + i].parentheticalId === span.id)).toBe(true);
  });

  it('does not treat a technical delimiter as a prose aside', () => {
    expect(find(doc, 'Decimal(9, 3)')?.parentheticalId).toBeNull();
  });

  it('retains language, line number and syntax tokens for code units', () => {
    const declaration = find(doc, 'SensorReading(BaseModel):');
    expect(declaration?.code?.language).toBe('python');
    expect(declaration?.code?.line).toBe(1);
    expect(declaration?.code?.tokens.length).toBeGreaterThan(0);
  });

  it('falls back to lexical units for an unsupported language', () => {
    const unsupported = doc.units.filter((u) => u.code?.language === 'plain');
    expect(unsupported.length).toBeGreaterThan(0);
    expect(unsupported.every((u) => u.code!.tokens.every((t) => t.type === 'plain'))).toBe(true);
  });

  it('derives sentences and links neighbours in document order', () => {
    expect(doc.sentences.length).toBeGreaterThan(5);
    for (let i = 0; i < doc.sentences.length; i++) {
      const s = doc.sentences[i];
      expect(s.prevSentence).toBe(i > 0 ? doc.sentences[i - 1].id : null);
      expect(s.nextSentence).toBe(i < doc.sentences.length - 1 ? doc.sentences[i + 1].id : null);
      expect(s.lastUnit).toBeGreaterThanOrEqual(s.firstUnit);
    }
  });

  it('derives a title from the first H1', () => {
    expect(doc.title).toBe('Sensor pipeline: unified readings schema');
  });

  it('reads unicode, emoji and CJK without losing units', () => {
    const texts = textsOf(doc);
    expect(texts).toContain('café,');
    expect(texts.some((t) => t.includes('日本語'))).toBe(true);
    expect(texts.some((t) => t.includes('👨‍👩‍👧‍👦'))).toBe(true);
  });

  it('degrades malformed markdown to readable text rather than dropping it', () => {
    const texts = textsOf(doc).join(' ');
    expect(texts).toContain('unclosed');
    expect(texts).toContain('Block');
  });
});

describe('list markers (SPEC 7.2)', () => {
  const LISTS = `## Migration ordering

1. Add \`batch_ids\` with a unique index.
2. Backfill from \`run_label\` in batches of 5000.

- [ ] Not done yet
- [x] Already done

- Top level
  - One level down
    - Two levels down

7) Custom start and delimiter.
`;
  const doc = buildDocument(LISTS);
  const markers = doc.units.filter((u) => u.marker !== undefined);

  it('gives every list item a marker unit', () => {
    expect(markers.map((u) => u.text)).toEqual([
      '1.', '2.', '☐', '☑', '•', '•', '•', '7)',
    ]);
  });

  it('preserves ordered numbering and the author’s delimiter', () => {
    expect(markers[0].marker).toBe('ordered');
    expect(markers[1].text).toBe('2.');
    // A list starting at 7 with `)` keeps both.
    expect(markers[7]).toMatchObject({ text: '7)', marker: 'ordered' });
  });

  it('distinguishes done from not-done task items', () => {
    expect(markers[2]).toMatchObject({ text: '☐', marker: 'task-todo' });
    expect(markers[3]).toMatchObject({ text: '☑', marker: 'task-done' });
  });

  it('maps each marker back to its real source range', () => {
    for (const marker of markers) {
      const sliced = LISTS.slice(marker.range.start, marker.range.end);
      expect(sliced.trim().length).toBeGreaterThan(0);
      // The range covers the source marker, not the item's prose.
      expect(/^(?:[-*+]|\d+[.)])(?:\s*\[[ xX]\])?$/.test(sliced.trim())).toBe(true);
    }
  });

  it('records nesting depth on the marker and on the item’s words', () => {
    const nested = doc.units.filter((u) => u.listDepth !== undefined);
    expect(nested.length).toBeGreaterThan(0);
    const top = doc.units.find((u) => u.text === 'Top')!;
    const one = doc.units.find((u) => u.text === 'One')!;
    const two = doc.units.find((u) => u.text === 'Two')!;
    expect(top.listDepth).toBe(1);
    expect(one.listDepth).toBe(2);
    expect(two.listDepth).toBe(3);
  });

  it('keeps markers out of the sentence and word context', () => {
    for (const marker of markers) {
      expect(marker.sentenceId).toBeNull();
      expect(marker.parentheticalId).toBeNull();
    }
    // The first word of an item still leads its own sentence.
    const add = doc.units.find((u) => u.text === 'Add')!;
    const sentence = doc.sentences.find((s) => s.id === add.sentenceId)!;
    expect(sentence.firstUnit).toBe(add.index);
  });

  it('places the marker immediately before its item', () => {
    const first = markers[0];
    expect(doc.units[first.index + 1].text).toBe('Add');
  });

  it('exposes the marker on the block for Browse', () => {
    const items = doc.blocks.filter((b) => b.kind === 'list-item');
    expect(items[0].marker).toEqual({ text: '1.', kind: 'ordered' });
    expect(items[2].marker).toEqual({ text: '☐', kind: 'task-todo' });
    expect(items[5].marker?.kind).toBe('bullet');
    expect(items[6].depth).toBe(3);
  });

  it('does not add a marker to a loose item’s continuation paragraph', () => {
    const loose = buildDocument('- First paragraph.\n\n  Second paragraph.\n');
    const withMarkers = loose.blocks.filter((b) => b.marker !== undefined);
    expect(withMarkers).toHaveLength(1);
    expect(loose.units.filter((u) => u.marker !== undefined)).toHaveLength(1);
  });

  it('leaves non-list prose untouched', () => {
    const prose = buildDocument('Just a sentence with a - hyphen in it.');
    expect(prose.units.some((u) => u.marker !== undefined)).toBe(false);
    expect(prose.units.some((u) => u.listDepth !== undefined)).toBe(false);
  });
});

describe('shortcut guide (SPEC 5.9)', () => {
  it('renders accelerators as macOS key symbols', () => {
    expect(formatAccelerator('Control+Alt+D')).toBe('⌃⌥D');
    expect(formatAccelerator('Control+Alt+Space')).toBe('⌃⌥Space');
    expect(formatAccelerator('Control+Alt+Left')).toBe('⌃⌥←');
    expect(formatAccelerator('Control+Alt+Shift+Right')).toBe('⌃⌥⇧→');
    expect(formatAccelerator('Command+/')).toBe('⌘/');
  });

  it('orders modifiers conventionally regardless of how they were bound', () => {
    expect(formatAccelerator('Shift+Alt+Control+K')).toBe('⌃⌥⇧K');
    expect(formatAccelerator('Command+Control+P')).toBe('⌃⌘P');
  });

  it('passes unknown keys through rather than showing nothing', () => {
    expect(formatAccelerator('Control+Alt+F13')).toBe('⌃⌥F13');
    expect(formatAccelerator('')).toBe('');
  });

  it('builds the guide from the bindings actually in effect', () => {
    const [focused, global] = buildGuide({
      documentMode: 'Control+Alt+D',
      // A rebound shortcut must be reflected, not the default.
      agentMode: 'Command+Shift+J',
    });

    expect(focused.entries.map((e) => e.description)).toContain('Play or pause');
    expect(focused.entries.some((e) => e.keys.includes('Esc'))).toBe(true);

    expect(global.entries).toEqual([
      { keys: ['⌃⌥D'], description: 'Read the clipboard' },
      { keys: ['⇧⌘J'], description: 'Read the latest agent response' },
    ]);
    // Unbound actions are omitted rather than rendered blank.
    expect(global.entries.some((e) => e.keys[0] === '')).toBe(false);
  });

  it('documents every focused key the overlay implements', () => {
    const [focused] = buildGuide({});
    const keys = focused.entries.flatMap((e) => e.keys);
    for (const key of ['Space', '←', '→', '⌥←', '⌥→', '↑', '↓', 'R', 'L', 'B', '?', 'Esc']) {
      expect(keys, key).toContain(key);
    }
  });
});

describe('plain-text documents', () => {
  it('has no headings and an uninterrupted progress bar', () => {
    const doc = buildDocument('Just two sentences. With no headings at all.');
    expect(doc.hasHeadings).toBe(false);
    expect(buildProgressMarkers(doc)).toHaveLength(0);
  });

  const buildProgressMarkers = (doc: ParsedDocument) =>
    buildStageSnapshot(doc, 1, 0).progress.markers;
});

describe('stage context (SPEC 5.6)', () => {
  const doc = buildDocument(CORPUS);

  it('draws word context from the same sentence only', () => {
    const target = doc.units.findIndex((u) => u.text === 'payload)');
    const snap = buildStageSnapshot(doc, 1, target);
    const sentenceId = doc.units[target].sentenceId;
    for (const w of [...snap.wordsBefore, ...snap.wordsAfter]) {
      expect(doc.units[w.index].sentenceId).toBe(sentenceId);
    }
    expect(snap.wordsBefore.length).toBeLessThanOrEqual(3);
    expect(snap.wordsAfter.length).toBeLessThanOrEqual(3);
  });

  it('exposes previous and next sentences as separate lanes', () => {
    const target = doc.units.findIndex((u) => u.text === 'payload)');
    const snap = buildStageSnapshot(doc, 1, target);
    expect(snap.previousSentence === null || typeof snap.previousSentence).not.toBe('undefined');
    expect(snap.nextSentence).not.toBe(undefined);
  });

  it('surfaces the active parenthetical on the secondary lane', () => {
    const target = doc.units.findIndex((u) => u.text === '(inferred');
    const snap = buildStageSnapshot(doc, 1, target);
    expect(snap.parenthetical).toBe('(inferred from the payload)');
  });

  it('reports the ancestor chain with the deepest heading active', () => {
    const target = doc.headings.find((h) => h.level === 6)!.unitIndex;
    const snap = buildStageSnapshot(doc, 1, target);
    expect(snap.headingChain.map((c) => c.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snap.headingChain.filter((c) => c.active)).toHaveLength(1);
    expect(snap.headingChain.at(-1)!.active).toBe(true);
  });

  it('weights progress markers by heading level and highlights the section', () => {
    const target = doc.headings.find((h) => h.text === 'Interfaces')!.unitIndex;
    const snap = buildStageSnapshot(doc, 1, target);
    expect(snap.progress.markers).toHaveLength(doc.headings.length);
    expect(snap.progress.markers.some((m) => m.level === 1)).toBe(true);
    expect(snap.progress.markers.some((m) => m.level === 6)).toBe(true);
    expect(snap.progress.sectionEnd).toBeGreaterThan(snap.progress.sectionStart);
    expect(snap.progress.remainingMs).toBeGreaterThan(0);
  });

  it('navigates by heading and restarts a section', () => {
    const interfaces = doc.headings.find((h) => h.text === 'Interfaces')!;
    const next = headingNeighbour(doc, interfaces.unitIndex, 1);
    expect(next).toBeGreaterThan(interfaces.unitIndex);
    expect(sectionStartIndex(doc, interfaces.unitIndex + 3)).toBe(interfaces.unitIndex);
  });
});

describe('determinism and scale (SPEC 14)', () => {
  it('produces identical output for identical input', () => {
    const a = buildDocument(CORPUS);
    const b = buildDocument(CORPUS);
    expect(textsOf(a)).toEqual(textsOf(b));
    expect(a.units.map((u) => u.dwellMs)).toEqual(b.units.map((u) => u.dwellMs));
  });

  it('parses and unitizes 100,000 words in under 3 seconds', () => {
    const paragraph =
      'The migration touches services/ingest/models/station_registry.py and reads ' +
      'station_record_id (inferred from the payload) before writing Decimal(9, 3) values. ';
    const words = paragraph.split(/\s+/).filter(Boolean).length;
    const big = `# Large document\n\n${paragraph.repeat(Math.ceil(100_000 / words))}`;
    const started = performance.now();
    const doc = buildDocument(big);
    const elapsed = performance.now() - started;
    expect(doc.units.length).toBeGreaterThan(50_000);
    expect(elapsed).toBeLessThan(3000);
  });
});
