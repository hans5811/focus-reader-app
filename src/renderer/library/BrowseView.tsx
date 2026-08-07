import { Fragment, useEffect, useMemo, useState } from 'react';
import type { DocumentDetail, OutlineBlock, SessionStateMessage } from '@shared/ipc';
import type { DocumentSummary } from '@shared/types';
import { resolveLanguage, tokenizeCode } from '@shared/code/highlight';
import { recognizeToken } from '@shared/text/technical';
import { api } from '../common/api';

/** Render a code block using the same tokenizer that produced its units. */
function Code({ text, language }: { text: string; language: string }): React.JSX.Element {
  const { body, resolved } = useMemo(() => {
    // Strip the fence lines; the block's source range includes them.
    const lines = text.split('\n');
    const fenced = /^\s*(```|~~~)/.test(lines[0] ?? '');
    const inner = fenced ? lines.slice(1, /^\s*(```|~~~)/.test(lines.at(-1) ?? '') ? -1 : undefined) : lines;
    return { body: inner.join('\n'), resolved: resolveLanguage(language) };
  }, [text, language]);

  const tokens = useMemo(() => tokenizeCode(body, resolved), [body, resolved]);

  return (
    <pre className="code-block" data-language={resolved || 'plain'}>
      <code>
        {tokens.map((token, i) => (
          <span key={i} className={`tok tok-${token.type}`}>
            {body.slice(token.start, token.end)}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * Render prose with recognized paths as actionable buttons. Reveal and Open are
 * always user-initiated and never execute the captured text (SPEC 9.2, 13).
 */
function Prose({ text }: { text: string }): React.JSX.Element {
  const parts = useMemo(() => text.split(/(\s+)/), [text]);
  return (
    <>
      {parts.map((part, i) => {
        const recognition = part.trim() ? recognizeToken(part.trim()) : null;
        if (recognition && (recognition.entity === 'path' || recognition.entity === 'filename')) {
          const value = part.trim();
          return (
            <Fragment key={i}>
              <button
                type="button"
                className="path-chip"
                title="Reveal in Finder"
                onClick={() => void api.revealPath(value, 'finder')}
                onDoubleClick={() => void api.revealPath(value, 'editor')}
              >
                {value}
              </button>
              {part.slice(part.indexOf(value) + value.length)}
            </Fragment>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function BlockContent({ block }: { block: OutlineBlock }): React.JSX.Element {
  if (block.kind === 'code') {
    return <Code text={block.text} language={block.language ?? ''} />;
  }
  if (block.kind === 'heading') {
    const level = Math.min(6, Math.max(1, block.depth ?? 1));
    const Tag = `h${level}` as 'h1';
    return <Tag className={`browse-heading level-${level}`}>{block.text.replace(/^#+\s*/, '')}</Tag>;
  }
  if (block.kind === 'thematic-break') return <hr />;
  if (block.kind === 'blockquote') {
    return (
      <blockquote>
        <Prose text={block.text.replace(/^>\s?/gm, '')} />
      </blockquote>
    );
  }
  if (block.kind === 'list-item') {
    // The block range already excludes the marker — Markdown consumed it — so
    // the marker is rendered from the parsed metadata and the depth drives the
    // indentation, rather than being stripped back out of the text.
    const depth = Math.max(1, block.depth ?? 1);
    return (
      <div
        className={`browse-item depth-${Math.min(depth, 6)}`}
        style={{ paddingInlineStart: `${(depth - 1) * 22}px` }}
      >
        <span className={`item-marker kind-${block.marker?.kind ?? 'bullet'}`} aria-hidden="true">
          {block.marker?.text ?? '•'}
        </span>
        <span className="item-body">
          <Prose text={block.text} />
        </span>
      </div>
    );
  }
  if (block.kind === 'table-cell') {
    return (
      <div className="table-cell">
        <Prose text={block.text} />
      </div>
    );
  }
  return (
    <p>
      <Prose text={block.text} />
    </p>
  );
}

export function BrowseView({
  documentId,
  onPickDocument,
}: {
  documentId: number | null;
  onPickDocument: (id: number) => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [showSource, setShowSource] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [position, setPosition] = useState<SessionStateMessage | null>(null);

  useEffect(() => {
    void api.listDocuments().then(setDocuments);
    return api.on('library:changed', () => void api.listDocuments().then(setDocuments));
  }, []);

  useEffect(() => {
    if (documentId === null) {
      setDetail(null);
      return;
    }
    void api.documentDetail(documentId).then(setDetail);
  }, [documentId]);

  useEffect(() => {
    void api.getSessionState().then(setPosition);
    return api.on('session:state', (p) => setPosition(p as SessionStateMessage));
  }, []);

  // The block that currently holds the reading position, so Browse and the
  // overlay always agree about where the reader is (SPEC 16).
  const activeBlockId = useMemo(() => {
    if (!detail || !position || position.documentId !== detail.summary.id) return null;
    const block = detail.blocks.find(
      (b) => position.unitIndex >= b.firstUnit && position.unitIndex <= b.lastUnit,
    );
    return block?.id ?? null;
  }, [detail, position]);

  const hiddenHeadings = useMemo(() => {
    if (!detail) return new Set<number>();
    const hidden = new Set<number>();
    for (const heading of detail.headings) {
      if (!collapsed.has(heading.id)) continue;
      const next = detail.headings.find(
        (h) => h.unitIndex > heading.unitIndex && h.level <= heading.level,
      );
      const end = next ? next.unitIndex : Infinity;
      for (const block of detail.blocks) {
        if (block.firstUnit > heading.unitIndex && block.firstUnit < end) hidden.add(block.id);
      }
    }
    return hidden;
  }, [detail, collapsed]);

  return (
    <section className="view browse">
      <aside className="browse-sidebar">
        <h2>Documents</h2>
        <ul className="sidebar-list">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                className={doc.id === documentId ? 'is-current' : ''}
                onClick={() => onPickDocument(doc.id)}
              >
                {doc.title}
              </button>
            </li>
          ))}
        </ul>

        {detail && detail.headings.length > 0 && (
          <>
            <h2>Outline</h2>
            <ul className="sidebar-list outline">
              {detail.headings.map((heading) => (
                <li key={heading.id} style={{ paddingInlineStart: `${(heading.level - 1) * 10}px` }}>
                  <button
                    type="button"
                    className="outline-toggle"
                    aria-expanded={!collapsed.has(heading.id)}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(heading.id)) next.delete(heading.id);
                        else next.add(heading.id);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(heading.id) ? '▸' : '▾'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void api.readFrom(detail.summary.id, heading.range.start)}
                    title="Read from here"
                  >
                    <span className="outline-level">H{heading.level}</span> {heading.text}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      <div className="browse-body">
        {!detail ? (
          <p className="empty">Select a document to browse it.</p>
        ) : (
          <>
            <header className="view-header">
              <h1>{detail.summary.title}</h1>
              <div className="toolbar">
                <button type="button" onClick={() => setShowSource((v) => !v)}>
                  {showSource ? 'Show formatted' : 'Show original source'}
                </button>
                <button type="button" onClick={() => void api.openDocument(detail.summary.id)}>
                  Read in overlay
                </button>
              </div>
            </header>

            {showSource ? (
              // The unmodified source, byte-for-byte as captured (SPEC 7.1).
              <pre className="source-view">{detail.source}</pre>
            ) : (
              <article className="browse-content">
                {detail.blocks
                  .filter((b) => !hiddenHeadings.has(b.id))
                  .map((block) => (
                    <div
                      key={block.id}
                      className={`browse-block ${block.id === activeBlockId ? 'is-current' : ''}`}
                    >
                      <button
                        type="button"
                        className="read-from-here"
                        title="Read from here"
                        onClick={() => void api.readFrom(detail.summary.id, block.range.start)}
                      >
                        ▶
                      </button>
                      <BlockContent block={block} />
                    </div>
                  ))}
              </article>
            )}
          </>
        )}
      </div>
    </section>
  );
}
