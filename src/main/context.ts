import type { OpenResult, OverlayStateMessage, ToastMessage } from '@shared/ipc';
import type { InboxWatcher } from './capture/inbox';
import type { PreferencesService } from './prefs';
import type { ReadingSession } from './session';
import type { ShortcutService } from './shortcuts';
import type { Store } from './store/db';
import type { LibraryWindowService } from './windows/library';
import type { UpdateService } from './update/service';
import type { OverlayWindowService } from './windows/overlay';

/** The two entry-point modes plus the shared open paths (SPEC 4.2). */
export interface EntryPoints {
  readClipboard(): OpenResult;
  readAgentResponse(): OpenResult;
  resume(): OpenResult;
  openDocument(documentId: number, startIndex?: number): OpenResult;
  importFile(filePath: string): OpenResult;
}

/** Services shared by the IPC layer, the tray, and the shortcut handlers. */
export interface AppContext {
  store: Store;
  prefs: PreferencesService;
  session: ReadingSession;
  overlay: OverlayWindowService;
  library: LibraryWindowService;
  shortcuts: ShortcutService;
  inbox: InboxWatcher;
  updates: UpdateService;
  entry: EntryPoints;
  supportDir: string;
  homeDir: string;
  readerctlPath(): string;
  overlayState(): OverlayStateMessage;
  broadcast(channel: string, payload: unknown): void;
  toast(message: ToastMessage): void;
  applyPreferences(): void;
  refreshTray(): void;
  quit(): void;
}
