import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, dedupKey, envelopeToImport } from '@main/store/db';
import { parseEnvelope, redact } from '@main/capture/inbox';
import {
  codexHookBlock,
  hookStatus,
  installHook,
  mergeClaudeSettings,
  planInstall,
  removeHook,
} from '@main/capture/hooks';
import { isValidGlobalAccelerator } from '@main/shortcuts';
import type { CaptureEnvelope } from '@shared/types';

const BINARY = '/Applications/Focus Reader.app/Contents/Resources/bin/readerctl';

function envelope(patch: Partial<CaptureEnvelope> = {}): CaptureEnvelope {
  return {
    schema_version: 1,
    source: 'claude-code',
    content: '# Response\n\nBody text.',
    captured_at: '2026-08-06T14:31:00Z',
    session_id: 's1',
    turn_id: 't1',
    cwd: '/repo',
    ...patch,
  };
}

describe('envelope validation (SPEC 10.2, 13)', () => {
  it('accepts a well-formed envelope', () => {
    const parsed = parseEnvelope(JSON.stringify(envelope()));
    expect(parsed?.session_id).toBe('s1');
    expect(parsed?.content).toBe('# Response\n\nBody text.');
  });

  it('rejects untrusted or malformed payloads', () => {
    const bad = [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...envelope(), schema_version: 2 }),
      JSON.stringify({ ...envelope(), source: 'evil' }),
      JSON.stringify({ ...envelope(), content: '' }),
      JSON.stringify({ ...envelope(), content: 42 }),
    ];
    for (const raw of bad) expect(parseEnvelope(raw), raw.slice(0, 40)).toBeNull();
  });

  it('drops fields of the wrong type rather than trusting them', () => {
    const parsed = parseEnvelope(
      JSON.stringify({ ...envelope(), session_id: { evil: true }, cwd: 12 }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.session_id).toBeUndefined();
    expect(parsed?.cwd).toBeUndefined();
  });

  it('substitutes a valid timestamp when the payload has none', () => {
    const parsed = parseEnvelope(JSON.stringify({ ...envelope(), captured_at: 'yesterday' }));
    expect(Number.isNaN(Date.parse(parsed!.captured_at))).toBe(false);
  });
});

describe('deduplication (SPEC 10.2)', () => {
  it('keys on source, session and turn when a turn id exists', () => {
    expect(dedupKey(envelopeToImport(envelope()))).toBe('claude-code:s1:t1');
  });

  it('falls back to a content hash scoped by cwd when the turn id is absent', () => {
    const withoutTurn = envelope({ turn_id: undefined });
    const a = dedupKey(envelopeToImport(withoutTurn));
    const b = dedupKey(envelopeToImport({ ...withoutTurn, content: 'different' }));
    const c = dedupKey(envelopeToImport({ ...withoutTurn, cwd: '/other' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(dedupKey(envelopeToImport(withoutTurn)));
  });

  it('redacts paths and identifiers from diagnostics', () => {
    const message = redact(
      new Error('failed at /Users/dev/secret/project/file.py for a3f1c2d4-5b6e-7a89-0c1d-2e3f4a5b6c7d'),
    );
    expect(message).not.toContain('secret');
    expect(message).toContain('<path>');
    expect(message).toContain('<uuid>');
  });
});

describe('store import and search', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-store-'));
    store = new Store(dir);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports a captured response once and returns the same document for duplicates', () => {
    const req = envelopeToImport(envelope());
    const first = store.import(req);
    const second = store.import(req);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(store.list()).toHaveLength(1);
  });

  it('preserves the original source byte-for-byte', () => {
    const content = '# Title\n\nText with `code` and a path app/models/x.py.\n';
    const { documentId } = store.import({ content, source: 'clipboard' });
    expect(store.rawContent(documentId)).toBe(content);
    expect(store.load(documentId)!.source).toBe(content);
  });

  it('round-trips reading units through SQLite without losing timing or ranges', () => {
    const content = '# H1\n\nRead services/ingest/models/station_registry.py now.\n';
    const { documentId } = store.import({ content, source: 'clipboard' });
    const loaded = store.load(documentId)!;
    const path = loaded.units.find((u) => u.text === 'services/ingest/models/station_registry.py');
    expect(path).toBeDefined();
    expect(path!.kind).toBe('path');
    expect(path!.dwellMs).toBeGreaterThan(400);
    expect(content.slice(path!.range.start, path!.range.end)).toBe(path!.text);
    expect(loaded.remainingMs[0]).toBe(loaded.totalMs);
  });

  it('round-trips list markers and nesting depth', () => {
    const content = '# Steps\n\n1. First step.\n2. Second step.\n\n- [x] Done\n  - Nested\n';
    const { documentId } = store.import({ content, source: 'clipboard' });
    const loaded = store.load(documentId)!;

    const markers = loaded.units.filter((u) => u.marker !== undefined);
    expect(markers.map((u) => [u.text, u.marker])).toEqual([
      ['1.', 'ordered'],
      ['2.', 'ordered'],
      ['☑', 'task-done'],
      ['•', 'bullet'],
    ]);
    expect(loaded.units.find((u) => u.text === 'Nested')?.listDepth).toBe(2);
    expect(loaded.blocks.find((b) => b.marker)?.marker).toEqual({ text: '1.', kind: 'ordered' });
  });

  it('reparses documents left on an older engine version', () => {
    const content = '# Steps\n\n1. First step.\n2. Second step.\n';
    const { documentId } = store.import({ content, source: 'clipboard' });
    store.setPosition(documentId, 3);

    // Pretend this document was imported by an earlier build.
    const raw = new DatabaseSync(path.join(dir, 'focus-reader.sqlite'));
    raw.exec("UPDATE documents SET parser_version = 'mdast-gfm/0'");
    raw.exec('DELETE FROM reading_units');
    raw.close();

    expect(store.reparseStale()).toBe(1);

    const loaded = store.load(documentId)!;
    expect(loaded.units.filter((u) => u.marker).map((u) => u.text)).toEqual(['1.', '2.']);
    expect(loaded.source).toBe(content); // the original is never rewritten
    expect(store.summary(documentId)!.unitIndex).toBe(3); // position preserved

    // Already current: nothing left to do.
    expect(store.reparseStale()).toBe(0);
  });

  it('adds new columns to a database created by an older build', () => {
    // Simulate an upgrade: drop the columns a previous version did not have.
    store.close();
    const raw = new DatabaseSync(path.join(dir, 'focus-reader.sqlite'));
    for (const stmt of [
      'ALTER TABLE reading_units DROP COLUMN marker',
      'ALTER TABLE reading_units DROP COLUMN list_depth',
      'ALTER TABLE blocks DROP COLUMN marker_text',
      'ALTER TABLE blocks DROP COLUMN marker_kind',
    ]) {
      raw.exec(stmt);
    }
    raw.close();

    // Reopening must migrate rather than fail on the first write.
    store = new Store(dir);
    const { documentId } = store.import({ content: '1. Step one.\n', source: 'clipboard' });
    expect(store.load(documentId)!.units[0].marker).toBe('ordered');
  });

  it('returns a bounded window rather than every unit', () => {
    const { documentId } = store.import({
      content: Array.from({ length: 900 }, (_, i) => `word${i}`).join(' '),
      source: 'clipboard',
    });
    const window = store.unitWindow(documentId, 500, 50);
    expect(window.length).toBe(101);
    expect(window[0].index).toBe(450);
  });

  it('finds documents with full-text search and tolerates punctuation', () => {
    store.import({ content: '# Migration plan\n\nBackfill batch_ids safely.', source: 'clipboard' });
    store.import({ content: '# Unrelated\n\nSomething else entirely.', source: 'clipboard' });
    expect(store.search('batch_ids')).toHaveLength(1);
    expect(store.search('Migration')[0].title).toBe('Migration plan');
    expect(() => store.search('AND OR "unbalanced')).not.toThrow();
  });

  it('picks the newest agent response and honours source filters', () => {
    store.import({ content: 'older', source: 'claude-code', sessionId: 'a', turnId: '1', capturedAt: '2026-08-01T00:00:00Z' });
    store.import({ content: 'newest', source: 'codex', sessionId: 'b', turnId: '2', capturedAt: '2026-08-05T00:00:00Z' });
    store.import({ content: 'clipboard only', source: 'clipboard' });

    expect(store.latestAgentResponse()!.source).toBe('codex');
    expect(store.latestAgentResponse({ sources: ['claude-code'] })!.source).toBe('claude-code');
  });

  it('persists reading position and marks a finished document as read', () => {
    const { documentId } = store.import({ content: 'one two three', source: 'clipboard' });
    const count = store.summary(documentId)!.unitCount;
    store.setPosition(documentId, 1);
    expect(store.summary(documentId)!.read).toBe(false);
    store.setPosition(documentId, count - 1);
    expect(store.summary(documentId)!.read).toBe(true);
  });

  it('records capture diagnostics with the content redacted', () => {
    const env = envelope();
    const { documentId } = store.import(envelopeToImport(env));
    store.recordCapture(env, 'imported', documentId);

    const last = store.lastCapture('claude-code');
    expect(last?.state).toBe('imported');
    expect(last?.error).toBeNull();

    // Re-recording the same event updates in place rather than duplicating.
    store.recordCapture(env, 'duplicate', documentId);
    expect(store.lastCapture('claude-code')?.state).toBe('duplicate');
  });

  it('deletes a document and its derived rows', () => {
    const { documentId } = store.import({ content: '# Gone\n\nText.', source: 'clipboard' });
    store.delete(documentId);
    expect(store.summary(documentId)).toBeNull();
    expect(store.load(documentId)).toBeNull();
    expect(store.search('Gone')).toHaveLength(0);
  });
});

describe('hook settings merge (SPEC 10.5, 15)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-home-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('preserves unrelated settings and unrelated hooks', () => {
    const existing = {
      theme: 'dark',
      permissions: { allow: ['Bash(npm run:*)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }],
      },
    };
    const { settings, changed } = mergeClaudeSettings(existing, 'readerctl ingest --source claude-code');
    expect(changed).toBe(true);
    expect(settings.theme).toBe('dark');
    expect(settings.permissions).toEqual(existing.permissions);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(hooks.Stop[0])).toContain('say done');
  });

  it('is idempotent', () => {
    const command = 'readerctl ingest --source claude-code';
    const once = mergeClaudeSettings({}, command);
    const twice = mergeClaudeSettings(once.settings, command);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toEqual(once.settings);
  });

  it('installs, backs up, detects, and removes the Claude Code hook', () => {
    const settingsFile = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2));

    expect(hookStatus('claude-code', home).installed).toBe(false);

    const outcome = installHook('claude-code', BINARY, home);
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(fs.readFileSync(outcome.backupPath!, 'utf8')).toContain('dark');
    expect(hookStatus('claude-code', home).installed).toBe(true);

    const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(written.theme).toBe('dark');
    expect(JSON.stringify(written)).toContain('ingest --source claude-code');

    // Re-running is a safe repair, not a duplicate.
    expect(installHook('claude-code', BINARY, home).changed).toBe(false);

    expect(removeHook('claude-code', home).changed).toBe(true);
    expect(hookStatus('claude-code', home).installed).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme).toBe('dark');
  });

  it('never overwrites a settings file it cannot parse', () => {
    const settingsFile = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '{ this is not json');

    const outcome = installHook('claude-code', BINARY, home);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toContain('not valid JSON');
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ this is not json');

    // The manual snippet is still offered so the user can proceed by hand.
    expect(planInstall('claude-code', BINARY, home).manualSnippet).toContain('claude-code');
  });

  it('appends the Codex block without rewriting existing TOML', () => {
    const configFile = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const original = '# my config\nmodel = "gpt-5"\n\n[tools]\nweb_search = true\n';
    fs.writeFileSync(configFile, original);

    expect(installHook('codex', BINARY, home).changed).toBe(true);
    const after = fs.readFileSync(configFile, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain('[[hooks.stop]]');
    expect(hookStatus('codex', home).installed).toBe(true);

    expect(installHook('codex', BINARY, home).changed).toBe(false);
    expect(removeHook('codex', home).changed).toBe(true);
    expect(fs.readFileSync(configFile, 'utf8')).toContain('web_search = true');
    expect(hookStatus('codex', home).installed).toBe(false);
  });

  it('quotes the helper path so a bundle name with spaces survives', () => {
    expect(codexHookBlock(`"${BINARY}" ingest --source codex`)).toContain(
      '"\\"/Applications/Focus Reader.app/Contents/Resources/bin/readerctl\\" ingest --source codex"',
    );
  });

  it('reports a plan before writing anything', () => {
    const plan = planInstall('claude-code', BINARY, home);
    expect(plan.fileExists).toBe(false);
    expect(plan.installed).toBe(false);
    expect(plan.proposed).toContain('ingest --source claude-code');
    expect(fs.existsSync(plan.file)).toBe(false);
  });
});

describe('global shortcut validation (SPEC 4.3, 19)', () => {
  it('refuses bare keys that would break other applications', () => {
    for (const bare of ['Space', 'Left', 'Right', 'Up', 'Down', 'A', 'Escape']) {
      expect(isValidGlobalAccelerator(bare).ok, bare).toBe(false);
    }
  });

  it('accepts the documented chorded defaults', () => {
    for (const chord of [
      'Control+Alt+D',
      'Control+Alt+A',
      'Control+Alt+Space',
      'Control+Alt+Left',
      'Control+Alt+Shift+Right',
    ]) {
      expect(isValidGlobalAccelerator(chord).ok, chord).toBe(true);
    }
  });

  it('rejects modifier-only and unknown-modifier chords', () => {
    expect(isValidGlobalAccelerator('Control+Alt').ok).toBe(false);
    expect(isValidGlobalAccelerator('Hyper+D').ok).toBe(false);
    expect(isValidGlobalAccelerator('').ok).toBe(false);
  });
});
