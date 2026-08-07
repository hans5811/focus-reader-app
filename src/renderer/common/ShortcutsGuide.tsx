import { useEffect, useMemo, useState } from 'react';
import { buildGuide, formatAccelerator } from '@shared/keys';
import type { PreferencesMessage, ShortcutStatus } from '@shared/ipc';
import { api } from './api';
import './shortcuts-guide.css';

export interface ShortcutsGuideProps {
  /** `overlay` is denser and sits over the reading stage. */
  variant: 'overlay' | 'window';
  /** Shown the first time the reader is summoned. */
  firstRun?: boolean;
  onClose?: () => void;
}

/**
 * The keyboard guide (SPEC 5.9), rendered from live preferences.
 *
 * Global shortcuts are rebindable, so this reads the current bindings rather
 * than a hardcoded list — after a rebind the guide is still correct. Any
 * shortcut that failed to register is called out here too, since a silent
 * conflict is otherwise invisible until you press the key and nothing happens.
 */
export function ShortcutsGuide({ variant, firstRun, onClose }: ShortcutsGuideProps): React.JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesMessage | null>(null);
  const [conflicts, setConflicts] = useState<ShortcutStatus[]>([]);

  useEffect(() => {
    void api.getPreferences().then(setPrefs);
    // Registration status is only meaningful for the global chords.
    void api
      .setupStatus()
      .then((status) => setConflicts(status.shortcuts.filter((s) => !s.registered)))
      .catch(() => setConflicts([]));
  }, []);

  const sections = useMemo(() => buildGuide(prefs?.shortcuts ?? {}), [prefs]);

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase so the overlay's reading keys do not also fire.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className={`shortcuts-guide variant-${variant}`}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <header className="guide-header">
        <div>
          <h2>{firstRun ? 'Welcome to Focus Reader' : 'Keyboard shortcuts'}</h2>
          {firstRun && (
            <p className="guide-intro">
              One word at a time, aligned on a fixed point so your eyes stay still. Here is
              everything you can press — you can reopen this any time with <kbd>?</kbd>.
            </p>
          )}
        </div>
        {onClose && (
          <button type="button" className="guide-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </header>

      {conflicts.length > 0 && (
        <p className="guide-conflict">
          {conflicts.length} shortcut{conflicts.length === 1 ? '' : 's'} could not be registered —
          another app is probably using {conflicts.length === 1 ? 'it' : 'them'}. Rebind in
          Capture &amp; Setup.
        </p>
      )}

      <div className="guide-body">
        {sections.map((section) => (
          <section key={section.title} className="guide-section">
            <h3>{section.title}</h3>
            <p className="guide-note">{section.note}</p>
            <dl className="guide-list">
              {section.entries.map((entry) => {
                const failed = conflicts.find(
                  (c) => formatAccelerator(c.accelerator) === entry.keys[0],
                );
                return (
                  <div
                    key={`${entry.keys.join('/')}-${entry.description}`}
                    className={`guide-row ${failed ? 'has-conflict' : ''}`}
                  >
                    <dt>
                      {entry.keys.map((key, i) => (
                        <span key={key}>
                          {i > 0 && <span className="guide-sep">/</span>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>
                      {entry.description}
                      {failed && <span className="guide-flag"> — not registered</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>

      <footer className="guide-footer">
        <span>Rebind any global shortcut in Capture &amp; Setup.</span>
        {variant === 'overlay' && (
          <button type="button" onClick={() => void api.openLibrary('setup')}>
            Open Capture &amp; Setup
          </button>
        )}
      </footer>
    </div>
  );
}
