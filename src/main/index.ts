import { BrowserWindow, Notification, app, clipboard, powerMonitor, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpenResult, OverlayStateMessage, ToastMessage } from '@shared/ipc';
import { InboxWatcher, type ImportedCapture } from './capture/inbox';
import type { AppContext, EntryPoints } from './context';
import { registerIpc } from './ipc';
import { PreferencesService } from './prefs';
import { ReadingSession } from './session';
import { ShortcutService } from './shortcuts';
import { Store } from './store/db';
import { TrayController } from './tray';
import { LibraryWindowService, markQuitting } from './windows/library';
import { OverlayWindowService } from './windows/overlay';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

// A single instance owns the inbox socket and the SQLite file.
if (!app.requestSingleInstanceLock()) app.exit(0);

// Menu-bar-first: no Dock icon, no window at launch (SPEC 4.1).
if (process.platform === 'darwin') app.setActivationPolicy('accessory');

app.whenReady().then(() => {
  const supportDir = app.getPath('userData');
  fs.mkdirSync(supportDir, { recursive: true });

  const store = new Store(supportDir);
  const prefs = new PreferencesService(store);

  let quitting = false;

  const overlay = new OverlayWindowService(prefs, (event) => {
    if (event === 'layout-changed' || event === 'mode-changed') {
      broadcast('overlay:state', overlayState());
      refreshTray();
    }
    if (event === 'dismissed') refreshTray();
  });

  const library = new LibraryWindowService();

  const session = new ReadingSession(store, prefs, (state, seeked) => {
    overlay.send('session:state', state);
    library.send('session:state', state);
    if (seeked) {
      const win = session.window();
      if (win) overlay.send('session:window', win);
    }
    refreshTray();
  });

  const inbox = new InboxWatcher(supportDir, store, (capture) => onCaptured(capture));
  const shortcuts = new ShortcutService(prefs);

  // ------------------------------------------------------------------ helpers

  function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  function toast(message: ToastMessage): void {
    broadcast('toast', message);
    if (!overlay.isVisible() && !library.isOpen() && message.level === 'error') {
      // Nothing of ours is on screen; a notification is the only quiet channel.
      showNotification('Focus Reader', message.message);
    }
  }

  function showNotification(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  }

  function overlayState(): OverlayStateMessage {
    const p = prefs.all();
    return {
      layout: overlay.currentLayout,
      mode: overlay.interactionMode,
      opacity: p.overlay.opacity,
      pinned: p.overlay.pinned,
      showPivotHighlight: p.overlay.showPivotHighlight,
    };
  }

  function readerctlPath(): string {
    // Packaged: Contents/Resources/bin/readerctl. Development: ./bin/readerctl.
    return app.isPackaged
      ? path.join(process.resourcesPath, 'bin', 'readerctl')
      : path.join(app.getAppPath(), 'bin', 'readerctl');
  }

  function refreshTray(): void {
    tray.update({
      layout: overlay.currentLayout,
      clickThrough: prefs.all().overlay.clickThrough,
      pinned: prefs.all().overlay.pinned,
      canResume: session.hasDocument() || store.list(1).length > 0,
    });
  }

  function applyPreferences(): void {
    broadcast('prefs:changed', prefs.all());
    broadcast('overlay:state', overlayState());
    refreshTray();
  }

  /** Open a document and summon a focused reading session (SPEC 4.2, 4.3). */
  function present(documentId: number, startIndex?: number): OpenResult {
    const options = startIndex === undefined ? {} : { startIndex };
    if (!session.open(documentId, options)) {
      return { ok: false, error: 'That document could not be opened.' };
    }
    overlay.summon({ focused: true });
    const win = session.window();
    if (win) overlay.send('session:window', win);
    overlay.send('session:state', session.state(overlay.currentLayout));
    broadcast('library:changed', null);
    refreshTray();
    return { ok: true, documentId };
  }

  // -------------------------------------------------------------- entry modes

  const entry: EntryPoints = {
    readClipboard(): OpenResult {
      // Read only as a direct consequence of the user's action (SPEC 12).
      const text = clipboard.readText();
      if (!text || text.trim().length === 0) {
        const available = clipboard.availableFormats();
        const message = available.some((f) => f.startsWith('image/'))
          ? 'The clipboard holds an image. Copy text or Markdown to read it.'
          : 'The clipboard is empty. Copy some text, then try again.';
        // The current session is left exactly as it was (SPEC 15).
        toast({ level: 'error', message });
        return { ok: false, error: message };
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
        const message = 'That text is larger than the 10 MB import limit.';
        toast({ level: 'error', message });
        return { ok: false, error: message };
      }
      const result = store.import(
        { content: text, source: 'clipboard' },
        { timing: prefs.all().timing, codeGranularity: prefs.all().codeGranularity },
      );
      // A re-read of the same clipboard resumes where it left off.
      return present(result.documentId, result.duplicate ? undefined : 0);
    },

    readAgentResponse(): OpenResult {
      const p = prefs.all().agentMode;
      const filter: Parameters<Store['latestAgentResponse']>[0] = {
        sources: p.sources,
        unreadOnly: p.unreadOnly,
      };
      if (p.repositoryOnly) filter.repository = p.repositoryOnly;
      const latest = store.latestAgentResponse(filter);
      if (!latest) {
        const message = 'No captured agent response yet. Open Capture & Setup to install the hooks.';
        toast({ level: 'error', message, action: 'open-setup' });
        return { ok: false, error: message };
      }
      // Resumes its stored position when already open (SPEC 4.2).
      return present(latest.id);
    },

    resume(): OpenResult {
      const current = session.currentDocumentId();
      if (current !== null) return present(current, session.currentIndex());
      const recent = store.list(1)[0];
      if (!recent) {
        const message = 'Nothing to resume yet.';
        toast({ level: 'error', message });
        return { ok: false, error: message };
      }
      return present(recent.id);
    },

    openDocument(documentId: number, startIndex?: number): OpenResult {
      return present(documentId, startIndex);
    },

    importFile(filePath: string): OpenResult {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_INPUT_BYTES) {
          return { ok: false, error: 'That file is larger than the 10 MB import limit.' };
        }
        const buffer = fs.readFileSync(filePath);
        // Reject binary content without losing the source reference (SPEC 12).
        if (buffer.includes(0)) {
          return { ok: false, error: `${path.basename(filePath)} looks like a binary file.` };
        }
        const result = store.import(
          {
            content: buffer.toString('utf8'),
            source: 'file',
            title: path.basename(filePath),
            repository: path.dirname(filePath),
          },
          { timing: prefs.all().timing, codeGranularity: prefs.all().codeGranularity },
        );
        broadcast('library:changed', null);
        return present(result.documentId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Could not read that file.' };
      }
    },
  };

  // ---------------------------------------------------------------- captures

  function onCaptured(capture: ImportedCapture): void {
    broadcast('library:changed', null);
    refreshTray();
    const p = prefs.all().capture;
    if (p.notify) {
      showNotification(
        capture.source === 'codex' ? 'Codex response captured' : 'Claude Code response captured',
        capture.title,
      );
    }
    // Never steals focus unless explicitly enabled (SPEC 12).
    if (p.autoSummon) present(capture.documentId);
  }

  // ------------------------------------------------------------------- tray

  const tray = new TrayController({
    readClipboard: () => entry.readClipboard(),
    readAgentResponse: () => entry.readAgentResponse(),
    resume: () => entry.resume(),
    setLayout: (layout) => {
      if (layout === 'peek') overlay.peek();
      else overlay.setLayout(layout);
    },
    toggleClickThrough: () => overlay.setClickThrough(!prefs.all().overlay.clickThrough),
    togglePin: () => {
      overlay.setPinned(!prefs.all().overlay.pinned);
      refreshTray();
    },
    openLibrary: () => library.open('library'),
    openSetup: () => library.open('setup'),
    openPreferences: () => library.open('preferences'),
    openShortcuts: () => library.open('shortcuts'),
    quit: () => quit(),
  });

  function quit(): void {
    if (quitting) return;
    quitting = true;
    markQuitting();
    session.flushPosition();
    shortcuts.unregisterAll();
    inbox.stop();
    tray.destroy();
    store.close();
    app.quit();
  }

  // -------------------------------------------------------------- app context

  const ctx: AppContext = {
    store,
    prefs,
    session,
    overlay,
    library,
    shortcuts,
    inbox,
    entry,
    supportDir,
    homeDir: os.homedir(),
    readerctlPath,
    overlayState,
    broadcast,
    toast,
    applyPreferences,
    refreshTray,
    quit,
  };

  registerIpc(ctx);

  // ------------------------------------------------------------- shortcuts

  const statuses = shortcuts.registerAll({
    documentMode: () => entry.readClipboard(),
    agentMode: () => entry.readAgentResponse(),
    toggleOverlay: () => {
      if (overlay.isVisible()) {
        session.pause();
        overlay.dismiss();
      } else if (session.hasDocument()) {
        overlay.summon({ focused: true });
      } else {
        entry.resume();
      }
    },
    playPause: () => session.togglePlay(),
    prevUnit: () => session.step(-1),
    nextUnit: () => session.step(1),
    prevHeading: () => session.stepHeading(-1),
    nextHeading: () => session.stepHeading(1),
    toggleClickThrough: () => overlay.setClickThrough(!prefs.all().overlay.clickThrough),
    cycleLayout: () => overlay.cycleLayout(),
    peek: () => overlay.peek(),
  });

  const failed = statuses.filter((s) => !s.registered);
  if (failed.length > 0) {
    // Registration failure must be visible and recoverable (SPEC 16).
    showNotification(
      'Focus Reader: shortcut conflict',
      `${failed.length} shortcut${failed.length === 1 ? '' : 's'} could not be registered. Open Capture & Setup to rebind.`,
    );
  }

  tray.create({
    layout: overlay.currentLayout,
    clickThrough: prefs.all().overlay.clickThrough,
    pinned: prefs.all().overlay.pinned,
    canResume: store.list(1).length > 0,
  });

  inbox.start();

  // Bring documents imported by an older engine up to the current parse.
  const reparsed = store.reparseStale({
    timing: prefs.all().timing,
    codeGranularity: prefs.all().codeGranularity,
  });
  if (reparsed > 0) broadcast('library:changed', null);

  // Retention: drop anything past the configured age at launch (SPEC 13).
  const retentionDays = prefs.all().retentionDays;
  if (retentionDays && retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    store.deleteOlderThan(cutoff);
  }

  // ----------------------------------------------------- lifecycle & security

  app.on('second-instance', () => inbox.drain());

  app.on('activate', () => {
    // Reactivating an accessory app must not force a window open.
    if (library.isOpen()) library.open();
  });

  // Menu-bar app: closing every window returns to menu-bar operation.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', () => {
    quitting = true;
    markQuitting();
    session.flushPosition();
  });

  app.on('will-quit', () => shortcuts.unregisterAll());

  // Block remote navigation, popups, and permission escalation (SPEC 11.3).
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const dev = process.env.VITE_DEV_SERVER_URL ?? '';
      if (!url.startsWith('file://') && !(dev && url.startsWith(dev))) {
        event.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  });

  // Pause when the screen locks or sleeps (SPEC 5.4).
  powerMonitor.on('suspend', () => session.pause());
  powerMonitor.on('lock-screen', () => session.pause());
});
