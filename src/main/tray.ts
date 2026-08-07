import { Menu, Tray, nativeImage } from 'electron';
import type { OverlayLayout } from '@shared/types';
import type { UpdateStatusMessage } from '@shared/update/status';

export interface TrayActions {
  readClipboard(): void;
  readAgentResponse(): void;
  resume(): void;
  setLayout(layout: OverlayLayout): void;
  toggleClickThrough(): void;
  togglePin(): void;
  openLibrary(): void;
  openSetup(): void;
  openPreferences(): void;
  openShortcuts(): void;
  checkForUpdate(): void;
  installUpdate(): void;
  quit(): void;
}

export interface TrayState {
  layout: OverlayLayout;
  clickThrough: boolean;
  pinned: boolean;
  canResume: boolean;
  update: UpdateStatusMessage;
}

const SIZE = 44; // 22pt at 2x
const SCALE = 2;

/**
 * Draw the menu-bar glyph as a template image: two context bars flanking a
 * filled pivot dot, which is the product's core idea in miniature. Building it
 * in code avoids shipping a binary asset and keeps it crisp at 2x.
 */
function trayImage(): Electron.NativeImage {
  const bgra = Buffer.alloc(SIZE * SIZE * 4);
  const set = (x: number, y: number, alpha: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    // Template images use alpha only; macOS supplies the colour.
    bgra[i] = 0;
    bgra[i + 1] = 0;
    bgra[i + 2] = 0;
    bgra[i + 3] = Math.max(bgra[i + 3], Math.round(alpha * 255));
  };

  const mid = SIZE / 2;
  // Pivot dot.
  const radius = 5;
  for (let y = -radius - 1; y <= radius + 1; y++) {
    for (let x = -radius - 1; x <= radius + 1; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d <= radius) set(mid + x, mid + y, Math.min(1, radius + 0.5 - d));
    }
  }
  // Context bars either side, quieter than the pivot.
  const barHeight = 4;
  for (let y = mid - barHeight / 2; y < mid + barHeight / 2; y++) {
    for (let x = 4; x < mid - radius - 4; x++) set(x, Math.floor(y), 0.55);
    for (let x = mid + radius + 4; x < SIZE - 4; x++) set(x, Math.floor(y), 0.55);
  }

  const image = nativeImage.createFromBitmap(bgra, {
    width: SIZE,
    height: SIZE,
    scaleFactor: SCALE,
  });
  image.setTemplateImage(true);
  return image;
}

/**
 * The update entry states the size of what it is about to do. A user deciding
 * whether to restart deserves to know it is a 0.7 MB fetch and not a 121 MB one,
 * and the difference is the entire point of the delta path.
 */
function updateItem(
  status: UpdateStatusMessage,
  actions: TrayActions,
): Electron.MenuItemConstructorOptions {
  switch (status.state) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'downloading': {
      const pct = status.total > 0 ? Math.round((status.received / status.total) * 100) : 0;
      return { label: `Downloading ${status.version}… ${pct}%`, enabled: false };
    }
    case 'ready':
      return {
        label: `Restart to Update to ${status.version} (${formatBytes(status.bytes)})`,
        click: () => actions.installUpdate(),
      };
    case 'manual':
      return {
        label: `Focus Reader ${status.version} is available…`,
        click: () => actions.checkForUpdate(),
      };
    case 'up-to-date':
      return { label: 'Focus Reader is up to date', enabled: false };
    default:
      return { label: 'Check for Updates…', click: () => actions.checkForUpdate() };
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.round(bytes / 1000)} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The menu-bar item is the app's primary control surface (SPEC 4.1). Clicking
 * it always opens the menu; the app never opens a window on launch.
 */
export class TrayController {
  private tray: Tray | null = null;

  constructor(private actions: TrayActions) {}

  create(state: TrayState): void {
    if (this.tray) return;
    this.tray = new Tray(trayImage());
    // Serves as the accessible label and hover affordance for the status item.
    this.tray.setToolTip('Focus Reader — rapid reading for technical documents');
    this.tray.setIgnoreDoubleClickEvents(true);
    this.update(state);
  }

  update(state: TrayState): void {
    if (!this.tray) return;
    const layoutItem = (label: string, layout: OverlayLayout) => ({
      label,
      type: 'radio' as const,
      checked: state.layout === layout,
      click: () => this.actions.setLayout(layout),
    });

    const menu = Menu.buildFromTemplate([
      { label: 'Read Clipboard', accelerator: 'Control+Alt+D', click: () => this.actions.readClipboard() },
      {
        label: 'Read Latest Agent Response',
        accelerator: 'Control+Alt+A',
        click: () => this.actions.readAgentResponse(),
      },
      {
        label: 'Resume Current Document',
        enabled: state.canResume,
        click: () => this.actions.resume(),
      },
      { type: 'separator' },
      {
        label: 'Overlay Layout',
        submenu: [
          layoutItem('Compact', 'compact'),
          layoutItem('Docked Rail', 'rail'),
          layoutItem('Peek', 'peek'),
          layoutItem('Expanded', 'expanded'),
        ],
      },
      {
        label: 'Click-through',
        type: 'checkbox',
        checked: state.clickThrough,
        accelerator: 'Control+Alt+T',
        click: () => this.actions.toggleClickThrough(),
      },
      { label: 'Pin Above Other Windows', type: 'checkbox', checked: state.pinned, click: () => this.actions.togglePin() },
      { type: 'separator' },
      { label: 'Keyboard Shortcuts…', accelerator: 'Command+/', click: () => this.actions.openShortcuts() },
      { label: 'Library…', click: () => this.actions.openLibrary() },
      { label: 'Capture & Setup…', click: () => this.actions.openSetup() },
      { label: 'Preferences…', accelerator: 'Command+,', click: () => this.actions.openPreferences() },
      { type: 'separator' },
      updateItem(state.update, this.actions),
      { type: 'separator' },
      { label: 'Quit Focus Reader', accelerator: 'Command+Q', click: () => this.actions.quit() },
    ]);

    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
