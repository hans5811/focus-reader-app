import type { ContextSettings } from './context';
import type { ReadingWindow } from './window';
import type {
  BlockKind,
  CaptureSource,
  CodeGranularity,
  DocumentSummary,
  Heading,
  InteractionMode,
  ListMarker,
  OverlayLayout,
  PlaybackStatus,
  SourceRange,
  TimingSettings,
} from './types';

/** Surfaces a renderer can be. Set via a preload argument, not by the page. */
export type Surface = 'overlay' | 'library';

export interface SessionStateMessage {
  documentId: number | null;
  title: string;
  unitIndex: number;
  unitCount: number;
  status: PlaybackStatus;
  layout: OverlayLayout;
  revision: number;
}

export interface OverlayStateMessage {
  layout: OverlayLayout;
  mode: InteractionMode;
  opacity: number;
  pinned: boolean;
  showPivotHighlight: boolean;
}

export type SessionCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'restartSection' }
  | { type: 'step'; value: number }
  | { type: 'seek'; value: number }
  | { type: 'heading'; value: -1 | 1 }
  | { type: 'wpm'; value: number }
  /** Position reached by the renderer's own dwell clock. */
  | { type: 'advance'; value: number; status: PlaybackStatus };

export interface PreferencesMessage {
  layout: OverlayLayout;
  timing: TimingSettings;
  context: ContextSettings;
  codeGranularity: CodeGranularity;
  overlay: {
    opacity: number;
    pinned: boolean;
    clickThrough: boolean;
    dockEdge: 'left' | 'right';
    peekTimeoutMs: number;
    pinnedDisplayId: number | null;
    showPivotHighlight: boolean;
  };
  agentMode: { sources: CaptureSource[]; repositoryOnly: string | null; unreadOnly: boolean };
  capture: { notify: boolean; autoSummon: boolean };
  onboarding: { shortcutsSeen: boolean };
  retentionDays: number | null;
  shortcuts: Record<string, string>;
}

export interface OutlineBlock {
  id: number;
  kind: BlockKind;
  range: SourceRange;
  firstUnit: number;
  lastUnit: number;
  language?: string;
  depth?: number;
  /** List marker, which the block's source range deliberately excludes. */
  marker?: ListMarker;
  /** Rendered text of the block, for the Browse view. */
  text: string;
}

export interface DocumentDetail {
  summary: DocumentSummary;
  source: string;
  headings: Heading[];
  blocks: OutlineBlock[];
}

export interface ShortcutStatus {
  action: string;
  label: string;
  accelerator: string;
  registered: boolean;
  /** Populated when registration failed, e.g. another app owns the chord. */
  error: string | null;
}

export interface CaptureStatus {
  source: Extract<CaptureSource, 'claude-code' | 'codex'>;
  file: string;
  installed: boolean;
  fileExists: boolean;
  problem: string | null;
  lastCapture: { createdAt: string; state: string; error: string | null } | null;
}

export interface SetupStatus {
  binaryPath: string;
  binaryPresent: boolean;
  captures: CaptureStatus[];
  shortcuts: ShortcutStatus[];
  inboxPath: string;
}

export interface HookPlanMessage {
  source: string;
  file: string;
  fileExists: boolean;
  installed: boolean;
  proposed: string;
  current: string;
  manualSnippet: string;
  backupPath: string;
}

export interface ToastMessage {
  level: 'info' | 'error';
  message: string;
  /** Optional action the UI can offer, e.g. opening Capture & Setup. */
  action?: 'open-setup' | 'open-library';
}

export interface OpenResult {
  ok: boolean;
  documentId?: number;
  error?: string;
}

/** Every channel the preload bridge will forward. Nothing else is reachable. */
export const INVOKE_CHANNELS = [
  'session:window',
  'session:command',
  'session:state',
  'overlay:dismiss',
  'overlay:setLayout',
  'overlay:cycleLayout',
  'overlay:setClickThrough',
  'overlay:takeFocus',
  'overlay:setGuideOpen',
  'overlay:endPeek',
  'overlay:state',
  'prefs:get',
  'prefs:set',
  'entry:clipboard',
  'entry:agentResponse',
  'entry:resume',
  'library:list',
  'library:search',
  'library:open',
  'library:delete',
  'library:deleteAll',
  'library:importFile',
  'document:detail',
  'document:readFrom',
  'document:reveal',
  'setup:status',
  'setup:plan',
  'setup:install',
  'setup:remove',
  'setup:test',
  'setup:rebindShortcut',
  'app:openLibrary',
  'app:quit',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Channels the main process pushes to renderers. */
export const EVENT_CHANNELS = [
  'session:state',
  'session:window',
  'overlay:state',
  'prefs:changed',
  'library:changed',
  'toast',
  'library:navigate',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** The typed API exposed on `window.focusReader`. */
export interface FocusReaderApi {
  surface: Surface;
  getWindow(center?: number): Promise<ReadingWindow | null>;
  sendCommand(command: SessionCommand): Promise<SessionStateMessage>;
  getSessionState(): Promise<SessionStateMessage>;
  dismissOverlay(): Promise<void>;
  setLayout(layout: OverlayLayout): Promise<void>;
  cycleLayout(): Promise<void>;
  setClickThrough(enabled: boolean): Promise<void>;
  takeFocus(): Promise<void>;
  /** Grow the overlay while the shortcuts guide is open, then restore it. */
  setGuideOpen(open: boolean): Promise<void>;
  endPeek(): Promise<void>;
  getOverlayState(): Promise<OverlayStateMessage>;
  getPreferences(): Promise<PreferencesMessage>;
  setPreferences(patch: Partial<PreferencesMessage>): Promise<PreferencesMessage>;
  readClipboard(): Promise<OpenResult>;
  readLatestAgentResponse(): Promise<OpenResult>;
  resume(): Promise<OpenResult>;
  listDocuments(): Promise<DocumentSummary[]>;
  searchDocuments(query: string): Promise<(DocumentSummary & { snippet: string })[]>;
  openDocument(documentId: number, startIndex?: number): Promise<OpenResult>;
  deleteDocument(documentId: number): Promise<void>;
  deleteAllDocuments(): Promise<void>;
  importFile(): Promise<OpenResult>;
  documentDetail(documentId: number): Promise<DocumentDetail | null>;
  readFrom(documentId: number, sourceOffset: number): Promise<OpenResult>;
  revealPath(value: string, mode: 'finder' | 'editor'): Promise<boolean>;
  setupStatus(): Promise<SetupStatus>;
  hookPlan(source: string): Promise<HookPlanMessage>;
  installHook(source: string): Promise<{ ok: boolean; changed: boolean; conflict: string | null; backupPath: string | null }>;
  removeHook(source: string): Promise<{ ok: boolean; changed: boolean; conflict: string | null; backupPath: string | null }>;
  testCapture(source: string): Promise<OpenResult>;
  rebindShortcut(action: string, accelerator: string): Promise<ShortcutStatus[]>;
  openLibrary(view?: 'library' | 'browse' | 'setup' | 'preferences'): Promise<void>;
  quit(): Promise<void>;
  on(channel: EventChannel, listener: (payload: never) => void): () => void;
}
