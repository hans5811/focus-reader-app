import { DEFAULT_CONTEXT, type ContextSettings } from '@shared/context';
import { DEFAULT_TIMING, type CaptureSource, type CodeGranularity, type OverlayLayout, type TimingSettings } from '@shared/types';
import type { Store } from './store/db';

/** Every globally bindable action (SPEC 5.9). */
export type ShortcutAction =
  | 'documentMode'
  | 'agentMode'
  | 'toggleOverlay'
  | 'playPause'
  | 'prevUnit'
  | 'nextUnit'
  | 'prevHeading'
  | 'nextHeading'
  | 'toggleClickThrough'
  | 'cycleLayout'
  | 'peek';

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  documentMode: 'Document Mode',
  agentMode: 'Agent Response Mode',
  toggleOverlay: 'Show / hide overlay',
  playPause: 'Global play / pause',
  prevUnit: 'Global previous unit',
  nextUnit: 'Global next unit',
  prevHeading: 'Global previous heading',
  nextHeading: 'Global next heading',
  toggleClickThrough: 'Toggle click-through',
  cycleLayout: 'Cycle persistent layout',
  peek: 'Peek',
};

/**
 * SPEC 5.9 proposed defaults. Every one is chorded: bare Space and arrows are
 * never registered globally, so editors and terminals keep working.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  documentMode: 'Control+Alt+D',
  agentMode: 'Control+Alt+A',
  toggleOverlay: 'Control+Alt+Space',
  playPause: 'Control+Alt+P',
  prevUnit: 'Control+Alt+Left',
  nextUnit: 'Control+Alt+Right',
  prevHeading: 'Control+Alt+Shift+Left',
  nextHeading: 'Control+Alt+Shift+Right',
  toggleClickThrough: 'Control+Alt+T',
  cycleLayout: 'Control+Alt+L',
  peek: 'Control+Alt+K',
};

export interface OverlayPreferences {
  opacity: number;
  pinned: boolean;
  clickThrough: boolean;
  dockEdge: 'left' | 'right';
  peekTimeoutMs: number;
  /** Keep the overlay on one display instead of following the pointer. */
  pinnedDisplayId: number | null;
  showPivotHighlight: boolean;
}

export interface AgentModePreferences {
  sources: CaptureSource[];
  repositoryOnly: string | null;
  unreadOnly: boolean;
}

export interface CapturePreferences {
  notify: boolean;
  /** Disabled by default: capture must never steal focus (SPEC 12). */
  autoSummon: boolean;
}

export interface OnboardingPreferences {
  /**
   * Cleared once the keyboard guide has been shown and dismissed. The guide
   * appears on the first *summon* rather than at launch, because a menu-bar
   * app must not open anything on its own at startup (SPEC 4.1).
   */
  shortcutsSeen: boolean;
}

export interface Preferences {
  shortcuts: Record<ShortcutAction, string>;
  layout: OverlayLayout;
  timing: TimingSettings;
  context: ContextSettings;
  codeGranularity: CodeGranularity;
  overlay: OverlayPreferences;
  agentMode: AgentModePreferences;
  capture: CapturePreferences;
  onboarding: OnboardingPreferences;
  retentionDays: number | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  shortcuts: { ...DEFAULT_SHORTCUTS },
  layout: 'compact',
  timing: { ...DEFAULT_TIMING },
  context: { ...DEFAULT_CONTEXT },
  codeGranularity: 'lexical',
  overlay: {
    opacity: 0.96,
    pinned: true,
    clickThrough: false,
    dockEdge: 'right',
    peekTimeoutMs: 2500,
    pinnedDisplayId: null,
    showPivotHighlight: true,
  },
  agentMode: {
    sources: ['claude-code', 'codex'],
    repositoryOnly: null,
    unreadOnly: false,
  },
  capture: { notify: true, autoSummon: false },
  onboarding: { shortcutsSeen: false },
  retentionDays: null,
};

const KEY = 'preferences';

function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const current = out[k];
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      out[k] = mergeDeep(current, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export class PreferencesService {
  private cached: Preferences;

  constructor(private store: Store) {
    this.cached = this.read();
  }

  private read(): Preferences {
    const raw = this.store.getPreference(KEY);
    if (!raw) return structuredClone(DEFAULT_PREFERENCES);
    try {
      return mergeDeep(structuredClone(DEFAULT_PREFERENCES), JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }

  all(): Preferences {
    return this.cached;
  }

  update(patch: Partial<Preferences>): Preferences {
    this.cached = mergeDeep(this.cached, patch);
    this.clamp();
    this.store.setPreference(KEY, JSON.stringify(this.cached));
    return this.cached;
  }

  private clamp(): void {
    const t = this.cached.timing;
    t.wpm = Math.min(700, Math.max(100, Math.round(t.wpm)));
    t.technicalSlowdown = Math.min(2, Math.max(1, t.technicalSlowdown));
    const o = this.cached.overlay;
    o.opacity = Math.min(1, Math.max(0.35, o.opacity));
    const c = this.cached.context;
    c.wordContextCount = Math.min(8, Math.max(0, Math.round(c.wordContextCount)));
    c.sentenceCharLimit = Math.min(240, Math.max(20, Math.round(c.sentenceCharLimit)));
  }

  /** Per-display overlay bounds, so each screen remembers its own frame. */
  bounds(displayId: number, layout: OverlayLayout): Electron.Rectangle | null {
    const raw = this.store.getPreference(`bounds:${displayId}:${layout}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Electron.Rectangle;
    } catch {
      return null;
    }
  }

  setBounds(displayId: number, layout: OverlayLayout, bounds: Electron.Rectangle): void {
    this.store.setPreference(`bounds:${displayId}:${layout}`, JSON.stringify(bounds));
  }
}
