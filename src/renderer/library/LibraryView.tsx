import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocumentSummary } from '@shared/types';
import { api } from '../common/api';

type Row = DocumentSummary & { snippet?: string };
type GroupBy = 'date' | 'source' | 'repository';

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  clipboard: 'Clipboard',
  file: 'File',
};

function groupKey(row: Row, by: GroupBy): string {
  if (by === 'source') return SOURCE_LABELS[row.source] ?? row.source;
  if (by === 'repository') return row.repository ?? 'No repository';
  const date = new Date(row.capturedAt);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return 'Today';
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function LibraryView({ onBrowse }: { onBrowse: (id: number) => void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('date');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      // Search is FTS5-backed in the main process; an empty query lists all.
      setRows(query.trim() ? await api.searchDocuments(query) : await api.listDocuments());
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    void reload();
    return api.on('library:changed', () => void reload());
  }, [reload]);

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const key = groupKey(row, groupBy);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return [...map.entries()];
  }, [rows, groupBy]);

  return (
    <section className="view">
      <header className="view-header">
        <h1>Library</h1>
        <div className="toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="inline-field">
            <span>Group by</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="date">Date</option>
              <option value="source">Source</option>
              <option value="repository">Repository</option>
            </select>
          </label>
          <button type="button" onClick={() => void api.importFile()}>
            Open file…
          </button>
        </div>
      </header>

      {rows.length === 0 && !busy && (
        <p className="empty">
          {query.trim()
            ? 'No documents match that search.'
            : 'Nothing captured yet. Copy some text and press ⌃⌥D, or install the capture hooks in Capture & Setup.'}
        </p>
      )}

      {groups.map(([label, items]) => (
        <div key={label} className="group">
          <h2 className="group-title">{label}</h2>
          <ul className="doc-list">
            {items.map((row) => {
              const progress = row.unitCount > 0 ? row.unitIndex / row.unitCount : 0;
              return (
                <li key={row.id} className={`doc-row ${row.read ? 'is-read' : ''}`}>
                  <button
                    type="button"
                    className="doc-main"
                    onClick={() => void api.openDocument(row.id)}
                    title="Open in the overlay and resume reading"
                  >
                    <span className="doc-title">{row.title}</span>
                    <span className="doc-meta">
                      <span className={`badge source-${row.source}`}>
                        {SOURCE_LABELS[row.source] ?? row.source}
                      </span>
                      {row.repository && <span className="doc-repo">{row.repository}</span>}
                      <span>{new Date(row.capturedAt).toLocaleString()}</span>
                      <span>{row.unitCount.toLocaleString()} units</span>
                      {row.read && <span className="badge read">Read</span>}
                    </span>
                    {row.snippet && (
                      <span className="doc-snippet">{row.snippet.replace(/[‹›]/g, '')}</span>
                    )}
                    <span className="doc-progress" aria-label={`${Math.round(progress * 100)}% read`}>
                      <span style={{ width: `${progress * 100}%` }} />
                    </span>
                  </button>
                  <div className="doc-actions">
                    <button type="button" onClick={() => onBrowse(row.id)}>
                      Browse
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void api.deleteDocument(row.id)}
                      title="Delete this document and its derived data"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
