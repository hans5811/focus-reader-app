import { useCallback, useEffect, useState } from 'react';
import type { HookPlanMessage, SetupStatus } from '@shared/ipc';
import { api } from '../common/api';

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** Build an Electron accelerator string from a real key event. */
function acceleratorFrom(event: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');

  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

  let named = key;
  if (key === ' ') named = 'Space';
  else if (key.startsWith('Arrow')) named = key.slice(5);
  else if (key.length === 1) named = key.toUpperCase();

  parts.push(named);
  return parts.length >= 2 ? parts.join('+') : null;
}

function ShortcutRow({
  action,
  label,
  accelerator,
  registered,
  error,
  onRebound,
}: SetupStatus['shortcuts'][number] & { onRebound: (s: SetupStatus['shortcuts']) => void }): React.JSX.Element {
  const [capturing, setCapturing] = useState(false);

  return (
    <tr className={registered ? '' : 'has-conflict'}>
      <td>{label}</td>
      <td>
        <button
          type="button"
          className={`shortcut-capture ${capturing ? 'is-capturing' : ''}`}
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={(event) => {
            if (!capturing) return;
            event.preventDefault();
            const next = acceleratorFrom(event);
            if (!next) return;
            setCapturing(false);
            void api.rebindShortcut(action, next).then(onRebound);
          }}
        >
          {capturing ? 'Press keys…' : accelerator}
        </button>
      </td>
      <td>
        {registered ? (
          <span className="status ok">Registered</span>
        ) : (
          <span className="status bad" title={error ?? undefined}>
            {error ?? 'Not registered'}
          </span>
        )}
      </td>
    </tr>
  );
}

export function SetupView(): React.JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [plan, setPlan] = useState<HookPlanMessage | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => setStatus(await api.setupStatus()), []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const review = async (source: string) => {
    setMessage(null);
    setPlan(await api.hookPlan(source));
  };

  const apply = async (source: string) => {
    const result = await api.installHook(source);
    setPlan(null);
    if (result.conflict) setMessage(result.conflict);
    else if (result.changed) {
      setMessage(
        result.backupPath
          ? `Installed. A backup was saved to ${result.backupPath}`
          : 'Installed.',
      );
    } else setMessage('Already installed — nothing changed.');
    await reload();
  };

  const remove = async (source: string) => {
    const result = await api.removeHook(source);
    setMessage(
      result.conflict ??
        (result.changed
          ? `Removed. A backup was saved to ${result.backupPath}`
          : 'Nothing to remove.'),
    );
    await reload();
  };

  const test = async (source: string) => {
    const result = await api.testCapture(source);
    setMessage(
      result.ok
        ? 'Test capture enqueued and imported. Press ⌃⌥A to read it.'
        : (result.error ?? 'Test capture failed.'),
    );
    await reload();
  };

  if (!status) return <section className="view" />;

  return (
    <section className="view">
      <header className="view-header">
        <h1>Capture &amp; Setup</h1>
      </header>

      {message && <div className="notice">{message}</div>}

      <div className="panel">
        <h2>Capture helper</h2>
        <p className="hint">
          Hooks run this bundled helper at the end of each agent turn. It writes the completed
          response to a local queue and exits; it never parses Markdown, calls a model, or executes
          captured text.
        </p>
        <dl className="facts">
          <dt>Helper</dt>
          <dd>
            <code>{status.binaryPath}</code>{' '}
            {status.binaryPresent ? (
              <span className="status ok">present</span>
            ) : (
              <span className="status bad">missing — run npm run build:helper</span>
            )}
          </dd>
          <dt>Queue</dt>
          <dd>
            <code>{status.inboxPath}</code>
          </dd>
        </dl>
      </div>

      {status.captures.map((capture) => (
        <div className="panel" key={capture.source}>
          <h2>
            {SOURCE_LABELS[capture.source]}{' '}
            {capture.installed ? (
              <span className="status ok">hook installed</span>
            ) : (
              <span className="status warn">not installed</span>
            )}
          </h2>

          <dl className="facts">
            <dt>Configuration file</dt>
            <dd>
              <code>{capture.file}</code>
              {!capture.fileExists && <span className="hint"> (will be created)</span>}
            </dd>
            <dt>Last capture</dt>
            <dd>
              {capture.lastCapture
                ? `${new Date(capture.lastCapture.createdAt).toLocaleString()} — ${capture.lastCapture.state}`
                : 'None yet'}
            </dd>
            {capture.lastCapture?.error && (
              <>
                <dt>Last error</dt>
                <dd className="status bad">{capture.lastCapture.error}</dd>
              </>
            )}
            {capture.problem && (
              <>
                <dt>Problem</dt>
                <dd className="status bad">{capture.problem}</dd>
              </>
            )}
          </dl>

          <div className="button-row">
            <button type="button" onClick={() => void review(capture.source)}>
              {capture.installed ? 'Review / repair' : 'Review changes…'}
            </button>
            <button type="button" onClick={() => void test(capture.source)}>
              Test capture
            </button>
            <button type="button" onClick={() => void reload()}>
              Verify
            </button>
            <button type="button" className="danger" onClick={() => void remove(capture.source)}>
              Remove hook
            </button>
          </div>

          {plan && plan.source === capture.source && (
            <div className="plan">
              <h3>Proposed change to {plan.file}</h3>
              <p className="hint">
                Nothing is written until you approve it. The existing file is backed up first, and
                unrelated settings are preserved.
              </p>
              <div className="plan-columns">
                <div>
                  <h4>Current</h4>
                  <pre>{plan.current || '(file does not exist)'}</pre>
                </div>
                <div>
                  <h4>After</h4>
                  <pre>{plan.proposed}</pre>
                </div>
              </div>
              <details>
                <summary>Configure manually instead</summary>
                <pre>{plan.manualSnippet}</pre>
              </details>
              <div className="button-row">
                <button type="button" className="primary" onClick={() => void apply(capture.source)}>
                  Apply change
                </button>
                <button type="button" onClick={() => setPlan(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="panel">
        <h2>Global shortcuts</h2>
        <p className="hint">
          Every global shortcut is chorded on purpose: bare Space and arrow keys are never
          registered system-wide, so editors, terminals and media keys keep working.
        </p>
        <table className="shortcut-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Shortcut</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {status.shortcuts.map((shortcut) => (
              <ShortcutRow
                key={shortcut.action}
                {...shortcut}
                onRebound={(shortcuts) => setStatus((s) => (s ? { ...s, shortcuts } : s))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
