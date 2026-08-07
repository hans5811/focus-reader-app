import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OverlayLayout } from '@shared/types';
import { DEFAULT_CONTEXT, type ContextSettings } from '@shared/context';
import type { OverlayStateMessage, PreferencesMessage, ToastMessage } from '@shared/ipc';
import { api } from '../common/api';
import { ShortcutsGuide } from '../common/ShortcutsGuide';
import { usePlayback } from '../common/usePlayback';
import { ReadingStage, type StageOptions } from './ReadingStage';

const LAYOUT_LABELS: Record<OverlayLayout, string> = {
  compact: 'Compact',
  rail: 'Docked Rail',
  peek: 'Peek',
  expanded: 'Expanded',
};

/**
 * Per-layout presentation only. Every layout feeds the same ReadingStage, so
 * none of them can drift into its own token, pivot, timing or context logic
 * (SPEC 5.1). Expanded in particular keeps the inline word row — there is no
 * stacked previous/current/next implementation anywhere.
 */
function stageOptions(layout: OverlayLayout, showPivotHighlight: boolean): StageOptions {
  const base: StageOptions = {
    showHeadings: true,
    showSentences: true,
    showWords: true,
    showProgress: true,
    showPivotHighlight,
    focusSize: 42,
    minFocusSize: 18,
    compactHeadings: false,
  };
  switch (layout) {
    case 'rail':
      return { ...base, focusSize: 26, minFocusSize: 14, compactHeadings: true };
    case 'peek':
      return {
        ...base,
        showSentences: false,
        showWords: false,
        focusSize: 34,
        minFocusSize: 16,
        compactHeadings: true,
      };
    case 'expanded':
      return { ...base, focusSize: 56, minFocusSize: 22 };
    default:
      return base;
  }
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function App(): React.JSX.Element {
  const [overlayState, setOverlayState] = useState<OverlayStateMessage>({
    layout: 'compact',
    mode: 'focused',
    opacity: 0.96,
    pinned: true,
    showPivotHighlight: true,
  });
  const [prefs, setPrefs] = useState<PreferencesMessage | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [guide, setGuide] = useState<'closed' | 'open' | 'first-run'>('closed');

  const context: ContextSettings = useMemo(() => prefs?.context ?? DEFAULT_CONTEXT, [prefs]);
  const playback = usePlayback(context);

  useEffect(() => {
    void (async () => {
      setOverlayState(await api.getOverlayState());
      const loaded = await api.getPreferences();
      setPrefs(loaded);
      // First summon: introduce the keys before the words start moving.
      if (!loaded.onboarding?.shortcutsSeen) setGuide('first-run');
    })();
    const offOverlay = api.on('overlay:state', (p) => setOverlayState(p as OverlayStateMessage));
    const offPrefs = api.on('prefs:changed', (p) => setPrefs(p as PreferencesMessage));
    const offToast = api.on('toast', (p) => {
      setToast(p as ToastMessage);
      setTimeout(() => setToast(null), 4000);
    });
    return () => {
      offOverlay();
      offPrefs();
      offToast();
    };
  }, []);

  const layout = overlayState.layout;
  const options = useMemo(
    () => stageOptions(layout, overlayState.showPivotHighlight),
    [layout, overlayState.showPivotHighlight],
  );

  const cycleLayout = useCallback(() => void api.cycleLayout(), []);

  const closeGuide = useCallback(() => {
    setGuide((current) => {
      if (current === 'first-run') {
        // Only mark it seen once it has actually been dismissed.
        void api.setPreferences({ onboarding: { shortcutsSeen: true } });
      }
      return 'closed';
    });
  }, []);

  // The window has to grow to hold the guide; window policy lives in main.
  useEffect(() => {
    void api.setGuideOpen(guide !== 'closed');
  }, [guide]);

  /**
   * Focused-session keys (SPEC 5.9). These are bare keys and only ever reach us
   * when the overlay itself holds focus; passive mode uses chorded global
   * shortcuts registered in the main process instead.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // While the guide is open it owns the keyboard; it handles its own
      // dismissal, so reading keys must not also fire underneath it.
      if (guide !== 'closed') return;

      if (event.key === '?') {
        event.preventDefault();
        setGuide('open');
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          playback.toggle();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (event.altKey) playback.stepHeading(-1);
          else playback.step(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (event.altKey) playback.stepHeading(1);
          else playback.step(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          playback.adjustWpm(25);
          break;
        case 'ArrowDown':
          event.preventDefault();
          playback.adjustWpm(-25);
          break;
        case 'Escape':
          event.preventDefault();
          setMenuAt(null);
          void api.dismissOverlay();
          break;
        default:
          if (event.metaKey || event.ctrlKey) return;
          switch (event.key.toLowerCase()) {
            case 'r':
              event.preventDefault();
              playback.restartSection();
              break;
            case 'l':
              event.preventDefault();
              cycleLayout();
              break;
            case 'b':
              event.preventDefault();
              void api.openLibrary('browse');
              break;
          }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playback, cycleLayout, guide]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setMenuAt({ x: event.clientX, y: event.clientY });
    };
    const onClick = () => setMenuAt(null);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('click', onClick);
    };
  }, []);

  const snapshot = playback.snapshot;
  const showTransport = layout === 'expanded';

  return (
    <div
      className={`overlay layout-${layout} mode-${overlayState.mode}`}
      style={{ ['--overlay-opacity' as string]: String(overlayState.opacity) }}
      onDoubleClick={() => {
        if (layout === 'peek') void api.endPeek();
      }}
    >
      <div className="drag-strip" aria-hidden="true" />

      {guide === 'closed' && layout !== 'peek' && (
        <button
          type="button"
          className="help-button"
          onClick={() => setGuide('open')}
          title="Keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
        >
          ?
        </button>
      )}

      {snapshot ? (
        <ReadingStage
          snapshot={snapshot}
          options={options}
          resting={playback.resting}
          onSeek={playback.seek}
        />
      ) : (
        <ReadingStage
          snapshot={{
            documentId: 0,
            title: '',
            unit: null,
            wordsBefore: [],
            wordsAfter: [],
            previousSentence: null,
            nextSentence: null,
            headingChain: [],
            parenthetical: null,
            dwellMs: 0,
            restMs: 0,
            progress: {
              unitIndex: 0,
              unitCount: 0,
              position: 0,
              markers: [],
              sectionStart: 0,
              sectionEnd: 1,
              remainingMs: 0,
              totalMs: 0,
              hasHeadings: false,
            },
          }}
          options={options}
        />
      )}

      {showTransport && snapshot && prefs && (
        <div className="transport">
          <div className="transport-buttons">
            <button type="button" onClick={() => playback.stepHeading(-1)} title="Previous heading (⌥←)">
              ⤒
            </button>
            <button type="button" onClick={() => playback.step(-1)} title="Previous unit (←)">
              ‹
            </button>
            <button
              type="button"
              className="primary"
              onClick={playback.toggle}
              title="Play or pause (Space)"
            >
              {playback.status === 'playing' ? '❚❚' : '▶'}
            </button>
            <button type="button" onClick={() => playback.step(1)} title="Next unit (→)">
              ›
            </button>
            <button type="button" onClick={() => playback.stepHeading(1)} title="Next heading (⌥→)">
              ⤓
            </button>
            <button type="button" onClick={playback.restartSection} title="Restart section (R)">
              ↺
            </button>
          </div>

          <label className="transport-field">
            <span>WPM</span>
            <input
              type="range"
              min={100}
              max={700}
              step={25}
              value={prefs.timing.wpm}
              onChange={(e) => {
                const wpm = Number(e.target.value);
                setPrefs({ ...prefs, timing: { ...prefs.timing, wpm } });
                void api.setPreferences({ timing: { ...prefs.timing, wpm } });
              }}
            />
            <output>{prefs.timing.wpm}</output>
          </label>

          <label className="transport-field">
            <span>Technical</span>
            <input
              type="range"
              min={1}
              max={2}
              step={0.05}
              value={prefs.timing.technicalSlowdown}
              onChange={(e) => {
                const technicalSlowdown = Number(e.target.value);
                setPrefs({ ...prefs, timing: { ...prefs.timing, technicalSlowdown } });
                void api.setPreferences({ timing: { ...prefs.timing, technicalSlowdown } });
              }}
            />
            <output>{prefs.timing.technicalSlowdown.toFixed(2)}×</output>
          </label>

          <div className="transport-meta">
            <span title="Estimated time remaining at the scheduled dwell durations">
              {formatDuration(snapshot.progress.remainingMs)} left
            </span>
            <span>·</span>
            <span>{formatDuration(snapshot.progress.totalMs)} total</span>
          </div>

          <select
            className="layout-switcher"
            value={layout}
            onChange={(e) => void api.setLayout(e.target.value as OverlayLayout)}
            aria-label="Overlay layout"
          >
            {(['compact', 'rail', 'peek', 'expanded'] as OverlayLayout[]).map((l) => (
              <option key={l} value={l}>
                {LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
      )}

      {menuAt && (
        <div className="context-menu" style={{ left: menuAt.x, top: menuAt.y }} role="menu">
          <div className="context-menu-title">Overlay layout</div>
          {(['compact', 'rail', 'peek', 'expanded'] as OverlayLayout[]).map((l) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={layout === l}
              className={layout === l ? 'is-current' : ''}
              onClick={() => void api.setLayout(l)}
            >
              {LAYOUT_LABELS[l]}
            </button>
          ))}
          <div className="context-menu-separator" />
          <button type="button" role="menuitem" onClick={() => void api.setClickThrough(overlayState.mode !== 'click-through')}>
            {overlayState.mode === 'click-through' ? 'Leave click-through' : 'Enable click-through'}
          </button>
          <button type="button" role="menuitem" onClick={() => void api.openLibrary('browse')}>
            Open Browse view
          </button>
          <button type="button" role="menuitem" onClick={() => setGuide('open')}>
            Keyboard shortcuts
          </button>
          <button type="button" role="menuitem" onClick={() => void api.dismissOverlay()}>
            Dismiss overlay
          </button>
        </div>
      )}

      {overlayState.mode === 'click-through' && (
        <div className="click-through-badge">
          Click-through — press <kbd>⌃⌥T</kbd> to interact
        </div>
      )}

      {guide !== 'closed' && (
        <ShortcutsGuide
          variant="overlay"
          firstRun={guide === 'first-run'}
          onClose={closeGuide}
        />
      )}

      {toast && <div className={`toast level-${toast.level}`}>{toast.message}</div>}
    </div>
  );
}
