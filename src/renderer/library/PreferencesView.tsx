import { useEffect, useState } from 'react';
import type { PreferencesMessage } from '@shared/ipc';
import type { CaptureSource, OverlayLayout } from '@shared/types';
import { api } from '../common/api';
import { UpdatePanel } from './UpdatePanel';

export function PreferencesView(): React.JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesMessage | null>(null);

  useEffect(() => {
    void api.getPreferences().then(setPrefs);
    return api.on('prefs:changed', (p) => setPrefs(p as PreferencesMessage));
  }, []);

  if (!prefs) return <section className="view" />;

  const patch = (next: Partial<PreferencesMessage>) => {
    setPrefs({ ...prefs, ...next } as PreferencesMessage);
    void api.setPreferences(next);
  };
  const timing = (next: Partial<PreferencesMessage['timing']>) =>
    patch({ timing: { ...prefs.timing, ...next } });
  const context = (next: Partial<PreferencesMessage['context']>) =>
    patch({ context: { ...prefs.context, ...next } });
  const overlay = (next: Partial<PreferencesMessage['overlay']>) =>
    patch({ overlay: { ...prefs.overlay, ...next } });

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    format: (v: number) => string = String,
  ) => (
    <label className="pref-row">
      <span className="pref-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{format(value)}</output>
    </label>
  );

  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label className="pref-row is-toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="pref-label">
        {label}
        {hint && <span className="hint"> {hint}</span>}
      </span>
    </label>
  );

  return (
    <section className="view">
      <header className="view-header">
        <h1>Preferences</h1>
      </header>

      <UpdatePanel />

      <div className="panel">
        <h2>Reading speed</h2>
        {slider('Words per minute', prefs.timing.wpm, 100, 700, 25, (wpm) => timing({ wpm }))}
        {slider(
          'Technical slowdown',
          prefs.timing.technicalSlowdown,
          1,
          2,
          0.05,
          (technicalSlowdown) => timing({ technicalSlowdown }),
          (v) => `${v.toFixed(2)}×`,
        )}
        {slider('Heading pause', prefs.timing.headingPause, 0.5, 2.5, 0.05, (headingPause) => timing({ headingPause }), (v) => `${v.toFixed(2)}×`)}
        {slider('Sentence pause', prefs.timing.sentencePause, 0.5, 2.5, 0.05, (sentencePause) => timing({ sentencePause }), (v) => `${v.toFixed(2)}×`)}
        {slider('Section-entry pause', prefs.timing.sectionEntryPause, 0.5, 2.5, 0.05, (sectionEntryPause) => timing({ sectionEntryPause }), (v) => `${v.toFixed(2)}×`)}
        {slider(
          'Sentence break',
          prefs.timing.sentenceBreak,
          0,
          2,
          0.05,
          (sentenceBreak) => timing({ sentenceBreak }),
          (v) => (v === 0 ? 'off' : `${v.toFixed(2)}×`),
        )}
      </div>

      <div className="panel">
        <h2>Context</h2>
        {toggle('Same-sentence word context', prefs.context.wordContext, (wordContext) => context({ wordContext }), '— words either side of the pivot')}
        {toggle('Adjacent sentence context', prefs.context.sentenceContext, (sentenceContext) => context({ sentenceContext }), '— lanes above and below')}
        {slider('Words either side', prefs.context.wordContextCount, 0, 8, 1, (wordContextCount) => context({ wordContextCount }))}
        {slider('Sentence character limit', prefs.context.sentenceCharLimit, 20, 240, 10, (sentenceCharLimit) => context({ sentenceCharLimit }))}
      </div>

      <div className="panel">
        <h2>Overlay</h2>
        <label className="pref-row">
          <span className="pref-label">Persistent layout</span>
          <select
            value={prefs.layout}
            onChange={(e) => patch({ layout: e.target.value as OverlayLayout })}
          >
            <option value="compact">Compact</option>
            <option value="rail">Docked Rail</option>
            <option value="expanded">Expanded</option>
          </select>
        </label>
        <label className="pref-row">
          <span className="pref-label">Rail edge</span>
          <select
            value={prefs.overlay.dockEdge}
            onChange={(e) => overlay({ dockEdge: e.target.value as 'left' | 'right' })}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        {slider('Opacity', prefs.overlay.opacity, 0.35, 1, 0.01, (opacity) => overlay({ opacity }), (v) => `${Math.round(v * 100)}%`)}
        {slider('Peek timeout', prefs.overlay.peekTimeoutMs, 500, 8000, 250, (peekTimeoutMs) => overlay({ peekTimeoutMs }), (v) => `${(v / 1000).toFixed(1)}s`)}
        {toggle('Keep above other windows', prefs.overlay.pinned, (pinned) => overlay({ pinned }))}
        {toggle('Click-through', prefs.overlay.clickThrough, (clickThrough) => overlay({ clickThrough }), '— pointer events pass to the app underneath')}
        {toggle(
          'Highlight the recognition pivot',
          prefs.overlay.showPivotHighlight,
          (showPivotHighlight) => overlay({ showPivotHighlight }),
          '— alignment stays fixed either way',
        )}
      </div>

      <div className="panel">
        <h2>Code</h2>
        <label className="pref-row">
          <span className="pref-label">Code unit size</span>
          <select
            value={prefs.codeGranularity}
            onChange={(e) => patch({ codeGranularity: e.target.value as 'declaration' | 'lexical' })}
          >
            <option value="lexical">Lexical — smaller expressions</option>
            <option value="declaration">Declaration — whole statements</option>
          </select>
        </label>
        <p className="hint">Applies to documents imported from now on.</p>
      </div>

      <div className="panel">
        <h2>Agent Response Mode</h2>
        <div className="pref-row is-toggle">
          {(['claude-code', 'codex'] as CaptureSource[]).map((source) => (
            <label key={source} className="inline-check">
              <input
                type="checkbox"
                checked={prefs.agentMode.sources.includes(source)}
                onChange={(e) => {
                  const sources = e.target.checked
                    ? [...prefs.agentMode.sources, source]
                    : prefs.agentMode.sources.filter((s) => s !== source);
                  patch({ agentMode: { ...prefs.agentMode, sources } });
                }}
              />
              {source === 'codex' ? 'Codex' : 'Claude Code'}
            </label>
          ))}
        </div>
        {toggle('Unread responses only', prefs.agentMode.unreadOnly, (unreadOnly) =>
          patch({ agentMode: { ...prefs.agentMode, unreadOnly } }),
        )}
        <label className="pref-row">
          <span className="pref-label">Restrict to repository</span>
          <input
            type="text"
            placeholder="Any repository"
            value={prefs.agentMode.repositoryOnly ?? ''}
            onChange={(e) =>
              patch({
                agentMode: { ...prefs.agentMode, repositoryOnly: e.target.value.trim() || null },
              })
            }
          />
        </label>
      </div>

      <div className="panel">
        <h2>Capture &amp; privacy</h2>
        {toggle('Notify when a response is captured', prefs.capture.notify, (notify) =>
          patch({ capture: { ...prefs.capture, notify } }),
        )}
        {toggle(
          'Summon the overlay on capture',
          prefs.capture.autoSummon,
          (autoSummon) => patch({ capture: { ...prefs.capture, autoSummon } }),
          '— off by default so capture never steals focus',
        )}
        <label className="pref-row">
          <span className="pref-label">Delete documents after</span>
          <select
            value={prefs.retentionDays ?? 0}
            onChange={(e) => patch({ retentionDays: Number(e.target.value) || null })}
          >
            <option value={0}>Never</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <p className="hint">
          No document content leaves this Mac. Diagnostics record metadata only, with paths and
          identifiers redacted.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (confirm('Delete every stored document and its derived data? This cannot be undone.')) {
                void api.deleteAllDocuments();
              }
            }}
          >
            Delete all documents
          </button>
        </div>
      </div>
    </section>
  );
}
