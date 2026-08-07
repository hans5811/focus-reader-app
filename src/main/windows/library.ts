import { BrowserWindow, app } from 'electron';
import path from 'node:path';

export type LibraryView = 'library' | 'browse' | 'setup' | 'preferences' | 'shortcuts';

/**
 * The Library is a secondary surface: it never opens at launch, and closing it
 * returns the app to plain menu-bar operation rather than quitting (SPEC 4.1).
 */
export class LibraryWindowService {
  private win: BrowserWindow | null = null;
  private pendingView: LibraryView = 'library';

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'Focus Reader',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#12131a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        additionalArguments: ['--focus-reader-surface=library'],
      },
    });

    win.on('close', (event) => {
      // Hide instead of destroying so reopening is instant and state survives.
      if (!isQuitting) {
        event.preventDefault();
        win.hide();
        if (BrowserWindow.getAllWindows().every((w) => !w.isVisible())) app.hide();
      }
    });
    win.on('closed', () => {
      this.win = null;
    });

    const devUrl = LIBRARY_VITE_DEV_SERVER_URL;
    if (devUrl) {
      void win.loadURL(devUrl);
    } else {
      void win.loadFile(path.join(__dirname, `../renderer/${LIBRARY_VITE_NAME}/index.html`));
    }

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('library:navigate', this.pendingView);
    });

    this.win = win;
    return win;
  }

  open(view: LibraryView = 'library'): void {
    this.pendingView = view;
    const win = this.win && !this.win.isDestroyed() ? this.win : this.create();
    if (win.webContents.isLoading()) {
      // did-finish-load will deliver the view.
    } else {
      win.webContents.send('library:navigate', view);
    }
    win.show();
    win.focus();
    app.focus({ steal: true });
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }
}

let isQuitting = false;
export function markQuitting(): void {
  isQuitting = true;
}
