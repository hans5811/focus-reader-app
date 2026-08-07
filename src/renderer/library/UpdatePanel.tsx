import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatusMessage } from '@shared/update/status';

const api = window.focusReader;

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.round(bytes / 1000)} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatChecked(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? 'just now' : when.toLocaleString();
}

/**
 * Updates.
 *
 * The panel always states the size of what it is proposing. Most releases change
 * only app code, which travels as a ~0.7 MB asar rather than the 121 MB bundle,
 * and a user deciding whether to restart now or later needs that number in front
 * of them — as does one being told, honestly, that this particular release does
 * require the full download.
 */
export function UpdatePanel(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatusMessage>({ state: 'idle' });
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    void api.updateStatus().then(setStatus);
    return api.on('update:status', (payload) => setStatus(payload as UpdateStatusMessage));
  }, []);

  const check = useCallback(() => {
    setInstallError(null);
    void api.checkForUpdate().then(setStatus);
  }, []);

  const install = useCallback(() => {
    setInstallError(null);
    void api.installUpdate().then((result) => {
      if (!result.ok) setInstallError(result.error ?? 'The update could not start.');
    });
  }, []);

  const busy = status.state === 'checking' || status.state === 'downloading';

  return (
    <div className="panel">
      <h2>Updates</h2>

      {status.state === 'idle' && (
        <p className="hint">Focus Reader checks for updates a few times a day.</p>
      )}

      {status.state === 'checking' && <p className="hint">Checking…</p>}

      {status.state === 'up-to-date' && (
        <p className="hint">
          Up to date on {status.version}. Last checked {formatChecked(status.lastChecked)}.
        </p>
      )}

      {status.state === 'downloading' && (
        <>
          <p className="hint">
            Downloading {status.version} — {formatBytes(status.received)} of{' '}
            {formatBytes(status.total)}.
          </p>
          <progress
            className="update-progress"
            value={status.total > 0 ? status.received : undefined}
            max={status.total > 0 ? status.total : undefined}
          />
        </>
      )}

      {status.state === 'ready' && (
        <>
          <p>
            <strong>Focus Reader {status.version}</strong> is ready to install.
          </p>
          {status.notes && <p className="hint">{status.notes}</p>}
          <p className="hint">
            {formatBytes(status.bytes)} downloaded — this release changed only the app itself, so
            none of the runtime had to come down again.
          </p>
          <div className="button-row">
            <button type="button" className="primary" onClick={install}>
              Restart and update
            </button>
          </div>
        </>
      )}

      {status.state === 'manual' && (
        <>
          <p>
            <strong>Focus Reader {status.version}</strong> is available.
          </p>
          {status.notes && <p className="hint">{status.notes}</p>}
          <p className="hint">{status.explanation}</p>
          <div className="button-row">
            <button type="button" onClick={() => void api.openUpdateDownload()}>
              Download the full version
            </button>
          </div>
        </>
      )}

      {status.state === 'error' && <p className="hint error-text">{status.message}</p>}
      {installError && <p className="hint error-text">{installError}</p>}

      {status.state !== 'ready' && (
        <div className="button-row">
          <button type="button" onClick={check} disabled={busy}>
            {busy ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      )}
    </div>
  );
}
