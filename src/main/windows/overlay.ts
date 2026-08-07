import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import type { InteractionMode, OverlayLayout } from '@shared/types';
import { PERSISTENT_LAYOUTS } from '@shared/types';
import type { PreferencesService } from '../prefs';

interface LayoutGeometry {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/** SPEC 5.2 target sizes. */
const GEOMETRY: Record<OverlayLayout, LayoutGeometry> = {
  // Wider than the 560pt minimum: the pivot is centred, so a long technical
  // unit only has half the row to live in.
  compact: { width: 820, height: 300, minWidth: 560, minHeight: 260 },
  rail: { width: 380, height: 620, minWidth: 320, minHeight: 320 },
  peek: { width: 460, height: 170, minWidth: 380, minHeight: 140 },
  expanded: { width: 940, height: 560, minWidth: 720, minHeight: 420 },
};

export interface SummonOptions {
  /** Focused sessions take keyboard focus so bare Space/arrows work (SPEC 4.3). */
  focused: boolean;
}

/**
 * Owns every overlay window policy decision (SPEC 11.4).
 *
 * React components never touch always-on-top, focusability, click-through,
 * workspace visibility, or bounds — all of it lives here in the main process.
 */
export class OverlayWindowService {
  private win: BrowserWindow | null = null;
  private layout: OverlayLayout = 'compact';
  /** Persistent layout to return to when Peek ends (SPEC 5.2). */
  private layoutBeforePeek: OverlayLayout = 'compact';
  private peekTimer: NodeJS.Timeout | null = null;
  private mode: InteractionMode = 'focused';
  private saveTimer: NodeJS.Timeout | null = null;
  /** Reading bounds to restore when the shortcuts guide closes. */
  private boundsBeforeGuide: Electron.Rectangle | null = null;

  constructor(
    private prefs: PreferencesService,
    private onEvent: (event: 'dismissed' | 'layout-changed' | 'mode-changed') => void,
  ) {
    this.layout = prefs.all().layout;
    this.layoutBeforePeek = this.layout;

    screen.on('display-removed', () => this.recoverOntoVisibleDisplay());
    screen.on('display-metrics-changed', () => this.recoverOntoVisibleDisplay());
  }

  get currentLayout(): OverlayLayout {
    return this.layout;
  }

  get interactionMode(): InteractionMode {
    return this.mode;
  }

  isVisible(): boolean {
    return this.win?.isVisible() ?? false;
  }

  private create(): BrowserWindow {
    const geometry = GEOMETRY[this.layout];
    const win = new BrowserWindow({
      ...geometry,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      roundedCorners: true,
      title: 'Focus Reader overlay',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        additionalArguments: ['--focus-reader-surface=overlay'],
      },
    });

    // Visible on every Space and alongside full-screen apps where macOS allows.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // The overlay is an ordinary, capturable window: never hidden from
    // screenshots or screen sharing (SPEC 3.2).
    win.setContentProtection(false);

    win.on('moved', () => this.scheduleBoundsSave());
    win.on('resized', () => this.scheduleBoundsSave());
    win.on('closed', () => {
      this.win = null;
    });

    const devUrl = OVERLAY_VITE_DEV_SERVER_URL;
    if (devUrl) {
      void win.loadURL(devUrl);
    } else {
      void win.loadFile(path.join(__dirname, `../renderer/${OVERLAY_VITE_NAME}/index.html`));
    }

    this.win = win;
    this.applyWindowPolicy();
    return win;
  }

  ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    return this.create();
  }

  private applyWindowPolicy(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const { overlay } = this.prefs.all();

    if (overlay.pinned) {
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      win.setAlwaysOnTop(false);
    }
    win.setOpacity(overlay.opacity);

    const clickThrough = this.mode === 'click-through';
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    // A click-through or passive overlay must not accept keyboard focus, or it
    // would swallow the bare keys the foreground app needs.
    win.setFocusable(this.mode === 'focused');
  }

  // ------------------------------------------------------------------ summon

  summon(options: SummonOptions): void {
    const win = this.ensure();
    this.mode = options.focused
      ? 'focused'
      : this.prefs.all().overlay.clickThrough
        ? 'click-through'
        : 'passive';

    this.positionForSummon();
    this.applyWindowPolicy();

    if (options.focused) {
      win.show();
      win.focus();
      // Accessory apps still need an explicit activation to receive key events.
      app.focus({ steal: true });
    } else {
      win.showInactive();
    }
    this.onEvent('mode-changed');
  }

  /** Hide the overlay and hand focus back to the previously active app. */
  dismiss(): void {
    this.cancelPeek();
    const win = this.win;
    if (win && !win.isDestroyed() && win.isVisible()) {
      this.saveBounds();
      win.hide();
    }
    this.mode = 'focused';
    this.restorePreviousApplication();
    this.onEvent('dismissed');
  }

  toggleVisibility(): void {
    if (this.isVisible()) this.dismiss();
    else this.summon({ focused: true });
  }

  private restorePreviousApplication(): void {
    if (process.platform !== 'darwin') return;
    // Only hide the whole app when nothing else of ours is on screen; otherwise
    // the Library would vanish along with the overlay.
    const others = BrowserWindow.getAllWindows().filter(
      (w) => w !== this.win && !w.isDestroyed() && w.isVisible(),
    );
    if (others.length === 0) app.hide();
  }

  // ------------------------------------------------------------------ layout

  setLayout(layout: OverlayLayout, persist = true): void {
    if (layout === this.layout) return;
    if (layout !== 'peek') this.layoutBeforePeek = layout;
    this.saveBounds();
    this.layout = layout;

    const win = this.ensure();
    const geometry = GEOMETRY[layout];
    win.setMinimumSize(geometry.minWidth, geometry.minHeight);
    win.setBounds(this.boundsFor(layout), false);
    win.setResizable(layout === 'compact' || layout === 'expanded' || layout === 'rail');

    if (persist && layout !== 'peek') this.prefs.update({ layout });
    this.onEvent('layout-changed');
  }

  cycleLayout(): void {
    const order = PERSISTENT_LAYOUTS;
    const current = this.layout === 'peek' ? this.layoutBeforePeek : this.layout;
    const next = order[(order.indexOf(current) + 1) % order.length];
    this.setLayout(next);
  }

  /** Transient inspection view that never disturbs playback (SPEC 5.2). */
  peek(): void {
    if (this.layout !== 'peek') this.layoutBeforePeek = this.layout;
    this.setLayout('peek', false);
    if (!this.isVisible()) this.summon({ focused: false });
    this.cancelPeek();
    this.peekTimer = setTimeout(() => this.endPeek(), this.prefs.all().overlay.peekTimeoutMs);
  }

  endPeek(): void {
    this.cancelPeek();
    if (this.layout === 'peek') this.setLayout(this.layoutBeforePeek, false);
  }

  private cancelPeek(): void {
    if (this.peekTimer) {
      clearTimeout(this.peekTimer);
      this.peekTimer = null;
    }
  }

  // ------------------------------------------------------------------- modes

  setClickThrough(enabled: boolean): void {
    this.prefs.update({ overlay: { ...this.prefs.all().overlay, clickThrough: enabled } });
    if (this.mode !== 'focused' || enabled) {
      this.mode = enabled ? 'click-through' : 'passive';
    }
    this.applyWindowPolicy();
    this.onEvent('mode-changed');
  }

  setPinned(pinned: boolean): void {
    this.prefs.update({ overlay: { ...this.prefs.all().overlay, pinned } });
    this.applyWindowPolicy();
  }

  setOpacity(opacity: number): void {
    this.prefs.update({ overlay: { ...this.prefs.all().overlay, opacity } });
    this.applyWindowPolicy();
  }

  /**
   * Temporarily grow the overlay so the shortcuts guide fits, then restore the
   * reading bounds. The guide is much taller than a reading stage, and a
   * scrolling help panel inside a 300pt window is not readable.
   */
  setGuideOpen(open: boolean): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    if (open) {
      if (this.boundsBeforeGuide) return;
      const current = win.getBounds();
      this.boundsBeforeGuide = current;
      const area = screen.getDisplayMatching(current).workArea;
      const width = Math.min(Math.max(current.width, 720), area.width - 40);
      const height = Math.min(560, area.height - 40);
      win.setMinimumSize(420, 320);
      win.setBounds(
        clampToArea(
          {
            width,
            height,
            x: current.x + Math.round((current.width - width) / 2),
            y: current.y + Math.round((current.height - height) / 2),
          },
          area,
        ),
        false,
      );
      return;
    }

    const restore = this.boundsBeforeGuide;
    this.boundsBeforeGuide = null;
    if (!restore) return;
    const geometry = GEOMETRY[this.layout];
    win.setMinimumSize(geometry.minWidth, geometry.minHeight);
    win.setBounds(restore, false);
  }

  /** Give an already-visible passive overlay keyboard focus. */
  takeFocus(): void {
    this.mode = 'focused';
    this.applyWindowPolicy();
    const win = this.ensure();
    win.show();
    win.focus();
    app.focus({ steal: true });
    this.onEvent('mode-changed');
  }

  // ------------------------------------------------------------------ bounds

  private targetDisplay(): Electron.Display {
    const pinnedId = this.prefs.all().overlay.pinnedDisplayId;
    if (pinnedId !== null) {
      const pinned = screen.getAllDisplays().find((d) => d.id === pinnedId);
      if (pinned) return pinned;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  private boundsFor(layout: OverlayLayout): Electron.Rectangle {
    const display = this.targetDisplay();
    const geometry = GEOMETRY[layout];
    const saved = this.prefs.bounds(display.id, layout);
    const area = display.workArea;

    if (layout === 'rail') {
      // The rail snaps to a display edge rather than restoring a free position.
      const width = Math.min(saved?.width ?? geometry.width, Math.floor(area.width / 2));
      const edge = this.prefs.all().overlay.dockEdge;
      return {
        x: edge === 'left' ? area.x : area.x + area.width - width,
        y: area.y,
        width,
        height: area.height,
      };
    }

    if (saved) return clampToArea(saved, area);

    return clampToArea(
      {
        x: area.x + Math.round((area.width - geometry.width) / 2),
        y: area.y + Math.round(area.height * 0.62),
        width: geometry.width,
        height: geometry.height,
      },
      area,
    );
  }

  private positionForSummon(): void {
    const win = this.ensure();
    const geometry = GEOMETRY[this.layout];
    win.setMinimumSize(geometry.minWidth, geometry.minHeight);
    win.setBounds(this.boundsFor(this.layout), false);
  }

  private scheduleBoundsSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveBounds(), 400);
  }

  private saveBounds(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || this.layout === 'peek') return;
    // The guide's temporary size is not a reading layout; never persist it.
    if (this.boundsBeforeGuide) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.prefs.setBounds(display.id, this.layout, bounds);
  }

  /** Bring the overlay back onto a live display after a monitor change. */
  private recoverOntoVisibleDisplay(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const visible = screen.getAllDisplays().some((d) => intersects(bounds, d.workArea));
    if (visible) return;
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds(clampToArea({ ...bounds, x: area.x, y: area.y }, area), false);
  }

  // -------------------------------------------------------------------- misc

  send(channel: string, payload: unknown): void {
    const win = this.win;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  webContentsId(): number | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents.id : null;
  }
}

function clampToArea(rect: Electron.Rectangle, area: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
  };
}

function intersects(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
