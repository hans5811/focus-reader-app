/**
 * Minimal Electron stand-in for unit tests.
 *
 * Only the surfaces the modules under test actually touch are implemented; the
 * real behaviours (window policy, tray, global registration) are verified on a
 * packaged build, as SPEC 17 requires.
 */
const registered = new Set<string>();

/** Accelerators a fake "other application" already owns, for conflict tests. */
export const takenAccelerators = new Set<string>();

export const globalShortcut = {
  register(accelerator: string): boolean {
    if (takenAccelerators.has(accelerator) || registered.has(accelerator)) return false;
    registered.add(accelerator);
    return true;
  },
  unregister(accelerator: string): void {
    registered.delete(accelerator);
  },
  unregisterAll(): void {
    registered.clear();
  },
  isRegistered(accelerator: string): boolean {
    return registered.has(accelerator);
  },
};

export const screen = {
  on() {},
  getAllDisplays: () => [],
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
};

export const app = {
  getPath: () => '/tmp',
  focus() {},
  hide() {},
  isPackaged: false,
  getAppPath: () => process.cwd(),
};

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return [];
  }
};

export const ipcMain = { handle() {} };
export const clipboard = { readText: () => '', availableFormats: () => [] as string[] };
export const shell = { showItemInFolder() {}, openPath: async () => '' };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const Notification = { isSupported: () => false };
export const powerMonitor = { on() {} };
export const nativeImage = { createFromBitmap: () => ({ setTemplateImage() {} }) };
export const Menu = { buildFromTemplate: () => ({}) };
export const Tray = class {};
export default { app, BrowserWindow, globalShortcut, ipcMain, screen };
