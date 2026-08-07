import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, type EventChannel, type Surface } from '@shared/ipc';

/**
 * Minimal preload bridge (SPEC 11.3).
 *
 * The renderer is sandboxed with `contextIsolation` on and no Node integration.
 * Only the calls below cross the boundary, each one a fixed channel name — the
 * page cannot construct an arbitrary channel, and every payload is re-validated
 * on the main side regardless of what is sent here.
 */
const surface: Surface =
  process.argv.find((a) => a.startsWith('--focus-reader-surface='))?.split('=')[1] === 'library'
    ? 'library'
    : 'overlay';

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

const api = {
  surface,

  // ---------------------------------------------------------------- playback
  getWindow: (center?: number) => invoke('session:window', { center }),
  sendCommand: (command: unknown) => invoke('session:command', command),
  getSessionState: () => invoke('session:state'),

  // ----------------------------------------------------------------- overlay
  dismissOverlay: () => invoke('overlay:dismiss'),
  setLayout: (layout: string) => invoke('overlay:setLayout', { layout }),
  cycleLayout: () => invoke('overlay:cycleLayout'),
  setClickThrough: (enabled: boolean) => invoke('overlay:setClickThrough', { enabled }),
  takeFocus: () => invoke('overlay:takeFocus'),
  setGuideOpen: (open: boolean) => invoke('overlay:setGuideOpen', { open }),
  endPeek: () => invoke('overlay:endPeek'),
  getOverlayState: () => invoke('overlay:state'),

  // ------------------------------------------------------------- preferences
  getPreferences: () => invoke('prefs:get'),
  setPreferences: (patch: unknown) => invoke('prefs:set', patch),

  // ------------------------------------------------------------ entry points
  readClipboard: () => invoke('entry:clipboard'),
  readLatestAgentResponse: () => invoke('entry:agentResponse'),
  resume: () => invoke('entry:resume'),

  // ----------------------------------------------------------------- library
  listDocuments: () => invoke('library:list'),
  searchDocuments: (query: string) => invoke('library:search', { query }),
  openDocument: (documentId: number, startIndex?: number) =>
    invoke('library:open', { documentId, startIndex }),
  deleteDocument: (documentId: number) => invoke('library:delete', { documentId }),
  deleteAllDocuments: () => invoke('library:deleteAll'),
  importFile: () => invoke('library:importFile'),
  documentDetail: (documentId: number) => invoke('document:detail', { documentId }),
  readFrom: (documentId: number, sourceOffset: number) =>
    invoke('document:readFrom', { documentId, sourceOffset }),
  revealPath: (value: string, mode: string) => invoke('document:reveal', { value, mode }),

  // ------------------------------------------------------------------- setup
  setupStatus: () => invoke('setup:status'),
  hookPlan: (source: string) => invoke('setup:plan', { source }),
  installHook: (source: string) => invoke('setup:install', { source }),
  removeHook: (source: string) => invoke('setup:remove', { source }),
  testCapture: (source: string) => invoke('setup:test', { source }),
  rebindShortcut: (action: string, accelerator: string) =>
    invoke('setup:rebindShortcut', { action, accelerator }),

  // --------------------------------------------------------------------- app
  openLibrary: (view?: string) => invoke('app:openLibrary', { view }),
  quit: () => invoke('app:quit'),

  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) return () => undefined;
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('focusReader', api);
