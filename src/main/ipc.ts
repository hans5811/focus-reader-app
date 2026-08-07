import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DocumentDetail,
  HookPlanMessage,
  OpenResult,
  OutlineBlock,
  PreferencesMessage,
  SessionCommand,
  SetupStatus,
} from '@shared/ipc';
import { INVOKE_CHANNELS } from '@shared/ipc';
import type { OverlayLayout } from '@shared/types';
import { PERSISTENT_LAYOUTS } from '@shared/types';
import { hookStatus, installHook, planInstall, removeHook, type HookSource } from './capture/hooks';
import type { AppContext } from './context';
import type { ShortcutAction } from './prefs';
import { SHORTCUT_LABELS } from './prefs';

/** Every payload from a renderer is untrusted and re-validated here. */
class Invalid extends Error {}

function asObject(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new Invalid('expected an object');
  return payload as Record<string, unknown>;
}

function asInt(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Invalid(`${field} must be a number`);
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) throw new Invalid(`${field} is out of range`);
  return rounded;
}

function asString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== 'string') throw new Invalid(`${field} must be a string`);
  if (value.length > maxLength) throw new Invalid(`${field} is too long`);
  return value;
}

function asBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Invalid(`${field} must be a boolean`);
  return value;
}

function asHookSource(value: unknown): HookSource {
  const s = asString(value, 'source', 32);
  if (s !== 'claude-code' && s !== 'codex') throw new Invalid('unknown capture source');
  return s;
}

function asLayout(value: unknown): OverlayLayout {
  const s = asString(value, 'layout', 32);
  if (!['compact', 'rail', 'peek', 'expanded'].includes(s)) throw new Invalid('unknown layout');
  return s as OverlayLayout;
}

function asCommand(payload: unknown): SessionCommand {
  const p = asObject(payload);
  const type = asString(p.type, 'type', 32);
  switch (type) {
    case 'play':
    case 'pause':
    case 'toggle':
    case 'restartSection':
      return { type } as SessionCommand;
    case 'step':
      return { type, value: asInt(p.value, 'value', -1_000_000, 1_000_000) };
    case 'seek':
      return { type, value: asInt(p.value, 'value', 0, 100_000_000) };
    case 'wpm':
      return { type, value: asInt(p.value, 'value', -600, 600) };
    case 'heading': {
      const value = asInt(p.value, 'value', -1, 1);
      if (value !== -1 && value !== 1) throw new Invalid('heading direction must be -1 or 1');
      return { type, value };
    }
    case 'advance': {
      const status = asString(p.status, 'status', 16);
      if (status !== 'playing' && status !== 'paused') throw new Invalid('bad status');
      return { type, value: asInt(p.value, 'value', 0, 100_000_000), status };
    }
    default:
      throw new Invalid('unknown command');
  }
}

/**
 * Register the allowlisted IPC surface.
 *
 * Handlers are registered by exact channel name from a fixed list; anything a
 * renderer sends is validated before it reaches the store, the session, or the
 * filesystem (SPEC 11.3).
 */
export function registerIpc(ctx: AppContext): void {
  const handle = (
    channel: (typeof INVOKE_CHANNELS)[number],
    handler: (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isKnownSender(event)) throw new Error('unauthorized sender');
      try {
        return await handler(payload, event);
      } catch (error) {
        if (error instanceof Invalid) throw new Error(`invalid ${channel} payload: ${error.message}`);
        throw error;
      }
    });
  };

  const isKnownSender = (event: Electron.IpcMainInvokeEvent): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win !== null && !win.isDestroyed();
  };

  // ---------------------------------------------------------------- playback

  handle('session:window', (payload) => {
    const p = asObject(payload);
    const center = p.center === undefined || p.center === null
      ? undefined
      : asInt(p.center, 'center', 0, 100_000_000);
    return ctx.session.window(center);
  });

  handle('session:state', () => ctx.session.state(ctx.overlay.currentLayout));

  handle('session:command', (payload) => {
    const command = asCommand(payload);
    switch (command.type) {
      case 'play': ctx.session.play(); break;
      case 'pause': ctx.session.pause(); break;
      case 'toggle': ctx.session.togglePlay(); break;
      case 'step': ctx.session.step(command.value); break;
      case 'seek': ctx.session.seek(command.value); break;
      case 'heading': ctx.session.stepHeading(command.value); break;
      case 'restartSection': ctx.session.restartSection(); break;
      case 'wpm': ctx.session.adjustWpm(command.value); break;
      case 'advance': ctx.session.advanceTo(command.value, command.status); break;
    }
    return ctx.session.state(ctx.overlay.currentLayout);
  });

  // ----------------------------------------------------------------- overlay

  handle('overlay:dismiss', () => {
    ctx.session.pause();
    ctx.overlay.dismiss();
  });
  handle('overlay:setLayout', (payload) => {
    ctx.overlay.setLayout(asLayout(asObject(payload).layout));
  });
  handle('overlay:cycleLayout', () => ctx.overlay.cycleLayout());
  handle('overlay:setClickThrough', (payload) => {
    ctx.overlay.setClickThrough(asBool(asObject(payload).enabled, 'enabled'));
  });
  handle('overlay:takeFocus', () => ctx.overlay.takeFocus());
  handle('overlay:setGuideOpen', (payload) => {
    ctx.overlay.setGuideOpen(asBool(asObject(payload).open, 'open'));
  });
  handle('overlay:endPeek', () => ctx.overlay.endPeek());
  handle('overlay:state', () => ctx.overlayState());

  // ------------------------------------------------------------- preferences

  handle('prefs:get', () => ctx.prefs.all() as unknown as PreferencesMessage);
  handle('prefs:set', (payload) => {
    const patch = asObject(payload);
    // Shortcuts are rebound through their own channel so conflicts are handled.
    delete patch.shortcuts;
    const before = ctx.prefs.all().timing;
    const next = ctx.prefs.update(patch as never);
    if (JSON.stringify(before) !== JSON.stringify(next.timing)) ctx.session.retime();
    ctx.applyPreferences();
    return next as unknown as PreferencesMessage;
  });

  // ------------------------------------------------------------ entry points

  handle('entry:clipboard', () => ctx.entry.readClipboard());
  handle('entry:agentResponse', () => ctx.entry.readAgentResponse());
  handle('entry:resume', () => ctx.entry.resume());

  // ----------------------------------------------------------------- library

  handle('library:list', () => ctx.store.list());
  handle('library:search', (payload) => ctx.store.search(asString(asObject(payload).query, 'query', 512)));
  handle('library:open', (payload): OpenResult => {
    const p = asObject(payload);
    const documentId = asInt(p.documentId, 'documentId', 1);
    const startIndex = p.startIndex === undefined || p.startIndex === null
      ? undefined
      : asInt(p.startIndex, 'startIndex', 0, 100_000_000);
    return ctx.entry.openDocument(documentId, startIndex);
  });
  handle('library:delete', (payload) => {
    const id = asInt(asObject(payload).documentId, 'documentId', 1);
    if (ctx.session.currentDocumentId() === id) ctx.session.close();
    ctx.store.delete(id);
    ctx.broadcast('library:changed', null);
  });
  handle('library:deleteAll', () => {
    ctx.session.close();
    ctx.store.deleteAll();
    ctx.broadcast('library:changed', null);
  });
  handle('library:importFile', async (): Promise<OpenResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Open a Markdown or text document',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    return ctx.entry.importFile(result.filePaths[0]);
  });

  // ---------------------------------------------------------------- document

  handle('document:detail', (payload): DocumentDetail | null => {
    const id = asInt(asObject(payload).documentId, 'documentId', 1);
    const summary = ctx.store.summary(id);
    const parsed = ctx.store.load(id);
    if (!summary || !parsed) return null;
    const blocks: OutlineBlock[] = parsed.blocks.map((b) => ({
      ...b,
      text: parsed.source.slice(b.range.start, b.range.end),
    }));
    return { summary, source: parsed.source, headings: parsed.headings, blocks };
  });

  handle('document:readFrom', (payload): OpenResult => {
    const p = asObject(payload);
    const id = asInt(p.documentId, 'documentId', 1);
    const offset = asInt(p.sourceOffset, 'sourceOffset', 0, 100_000_000);
    const opened = ctx.entry.openDocument(id);
    if (!opened.ok) return opened;
    ctx.session.seek(ctx.session.unitIndexForSourceOffset(offset));
    return opened;
  });

  handle('document:reveal', async (payload) => {
    const p = asObject(payload);
    const value = asString(p.value, 'value', 2048);
    const mode = asString(p.mode, 'mode', 16);
    // User-initiated only, and only for a path that actually exists. The value
    // is passed as an argument, never interpolated into a shell command.
    const resolved = path.resolve(value.startsWith('~') ? value.replace(/^~/, ctx.homeDir) : value);
    if (!fs.existsSync(resolved)) return false;
    if (mode === 'finder') {
      shell.showItemInFolder(resolved);
      return true;
    }
    const error = await shell.openPath(resolved);
    return error === '';
  });

  // ------------------------------------------------------------------- setup

  handle('setup:status', (): SetupStatus => {
    const binaryPath = ctx.readerctlPath();
    return {
      binaryPath,
      binaryPresent: fs.existsSync(binaryPath),
      inboxPath: path.join(ctx.supportDir, 'inbox', 'ready'),
      captures: (['claude-code', 'codex'] as HookSource[]).map((source) => ({
        ...hookStatus(source, ctx.homeDir),
        lastCapture: ctx.store.lastCapture(source),
      })),
      shortcuts: ctx.shortcuts.status(),
    };
  });

  handle('setup:plan', (payload): HookPlanMessage => {
    const source = asHookSource(asObject(payload).source);
    return planInstall(source, ctx.readerctlPath(), ctx.homeDir);
  });

  handle('setup:install', (payload) => {
    const source = asHookSource(asObject(payload).source);
    return installHook(source, ctx.readerctlPath(), ctx.homeDir);
  });

  handle('setup:remove', (payload) => {
    const source = asHookSource(asObject(payload).source);
    return removeHook(source, ctx.homeDir);
  });

  handle('setup:test', async (payload): Promise<OpenResult> => {
    const source = asHookSource(asObject(payload).source);
    const binary = ctx.readerctlPath();
    if (!fs.existsSync(binary)) return { ok: false, error: 'readerctl is not installed in this build.' };

    const sample = JSON.stringify({
      session_id: 'focus-reader-test',
      turn_id: `test-${Date.now()}`,
      cwd: ctx.homeDir,
      hook_event_name: 'Stop',
      last_assistant_message: TEST_CAPTURE_BODY,
      last_agent_message: TEST_CAPTURE_BODY,
    });

    // Exercises the real helper, the real inbox, and the real import path.
    const ok = await new Promise<boolean>((resolve) => {
      const child = execFile(
        binary,
        ['ingest', '--source', source, '--home', ctx.supportDir],
        { timeout: 5000 },
        (error) => resolve(!error),
      );
      child.stdin?.end(sample);
    });
    if (!ok) return { ok: false, error: 'readerctl did not complete.' };

    ctx.inbox.drain();
    return { ok: true };
  });

  handle('setup:rebindShortcut', (payload) => {
    const p = asObject(payload);
    const action = asString(p.action, 'action', 64);
    if (!(action in SHORTCUT_LABELS)) throw new Invalid('unknown action');
    const accelerator = asString(p.accelerator, 'accelerator', 128);
    const statuses = ctx.shortcuts.rebind(action as ShortcutAction, accelerator);
    ctx.refreshTray();
    return statuses;
  });

  // --------------------------------------------------------------------- app

  handle('app:openLibrary', (payload) => {
    const view = asObject(payload).view;
    const named = view === undefined || view === null ? 'library' : asString(view, 'view', 32);
    if (!['library', 'browse', 'setup', 'preferences', 'shortcuts'].includes(named)) {
      throw new Invalid('unknown view');
    }
    ctx.library.open(named as 'library');
  });

  handle('app:quit', () => ctx.quit());
}

const TEST_CAPTURE_BODY = `# Focus Reader test capture

This document was created by the **Capture & Setup** test action. If you can read
it in the overlay, the hook path works end to end: \`readerctl\` wrote an event to
the inbox, and Focus Reader imported it.

- Technical units stay intact, like \`station_record_id\`.
- So do paths, like \`services/ingest/models/station_registry.py\`.
`;

export { PERSISTENT_LAYOUTS };
