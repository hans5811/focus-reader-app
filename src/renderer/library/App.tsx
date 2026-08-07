import { useEffect, useState } from 'react';
import type { ToastMessage } from '@shared/ipc';
import { api } from '../common/api';
import { ShortcutsGuide } from '../common/ShortcutsGuide';
import { BrowseView } from './BrowseView';
import { LibraryView } from './LibraryView';
import { PreferencesView } from './PreferencesView';
import { SetupView } from './SetupView';

type View = 'library' | 'browse' | 'setup' | 'preferences' | 'shortcuts';

const TABS: { id: View; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'browse', label: 'Browse' },
  { id: 'setup', label: 'Capture & Setup' },
  { id: 'preferences', label: 'Preferences' },
];

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('library');
  const [browseId, setBrowseId] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    const offNavigate = api.on('library:navigate', (payload) => {
      const next = payload as View;
      if (next === 'shortcuts' || TABS.some((t) => t.id === next)) setView(next);
    });
    const offToast = api.on('toast', (payload) => {
      setToast(payload as ToastMessage);
      setTimeout(() => setToast(null), 5000);
    });
    return () => {
      offNavigate();
      offToast();
    };
  }, []);

  // Browse defaults to whatever is currently open in the overlay.
  useEffect(() => {
    if (view !== 'browse' || browseId !== null) return;
    void api.getSessionState().then((state) => {
      if (state.documentId !== null) setBrowseId(state.documentId);
    });
  }, [view, browseId]);

  const openBrowse = (id: number) => {
    setBrowseId(id);
    setView('browse');
  };

  return (
    <div className="app">
      <header className="titlebar">
        <nav className="tabs" aria-label="Sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={view === tab.id ? 'is-active' : ''}
              aria-current={view === tab.id ? 'page' : undefined}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          className={`help-tab ${view === 'shortcuts' ? 'is-active' : ''}`}
          onClick={() => setView('shortcuts')}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
          aria-current={view === 'shortcuts' ? 'page' : undefined}
        >
          ?
        </button>
      </header>

      <main className="content">
        {view === 'library' && <LibraryView onBrowse={openBrowse} />}
        {view === 'browse' && <BrowseView documentId={browseId} onPickDocument={setBrowseId} />}
        {view === 'setup' && <SetupView />}
        {view === 'preferences' && <PreferencesView />}
        {view === 'shortcuts' && (
          <section className="view">
            <ShortcutsGuide variant="window" />
          </section>
        )}
      </main>

      {toast && <div className={`app-toast level-${toast.level}`}>{toast.message}</div>}
    </div>
  );
}
