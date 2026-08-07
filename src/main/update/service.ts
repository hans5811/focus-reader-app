import { app, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideUpdate,
  explainFull,
  parseManifest,
  type InstallContext,
  type UpdateDecision,
  type UpdateManifest,
} from '@shared/update/manifest';
import type { UpdateStatusMessage } from '@shared/update/status';
import { checksumMatches, verifyManifestSignature } from '@shared/update/verify';

/**
 * Update checking and staging.
 *
 * A release that changes only app code ships as a ~744 KB asar instead of the
 * 121 MB bundle. This service decides whether that applies, proves the payload
 * is ours, stages it, and hands the actual swap to `readerctl apply-update` —
 * the app cannot rewrite an asar it currently has mapped.
 *
 * Trust does not come from TLS alone. The manifest carries a detached Ed25519
 * signature checked against a key compiled into the app, so a compromised
 * release host still cannot push code.
 */

const REPO = 'hans5811/focus-reader';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/update.json`;
const SIGNATURE_URL = `${MANIFEST_URL}.sig`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DELTA_BYTES = 32 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30_000;

export type UpdateStatus = UpdateStatusMessage;

export class UpdateService {
  private status: UpdateStatus = { state: 'idle' };
  private timer: NodeJS.Timeout | null = null;
  private staged: { jobPath: string; version: string } | null = null;
  private inFlight = false;
  private fullDownloadUrl: string | null = null;

  constructor(
    private readonly supportDir: string,
    private readonly readerctlPath: () => string,
    private readonly onStatus: (status: UpdateStatus) => void,
  ) {}

  current(): UpdateStatus {
    return this.status;
  }

  /**
   * Begin periodic checking. Deliberately not immediate: launch is the worst
   * moment to spend the user's bandwidth, and an app that has just started is
   * the one least likely to be left running long enough to matter.
   */
  start(): void {
    if (!this.enabled()) return;
    setTimeout(() => void this.check(false), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True when this build can meaningfully check for updates at all. */
  enabled(): boolean {
    return app.isPackaged && process.platform === 'darwin';
  }

  async check(manual: boolean): Promise<UpdateStatus> {
    if (!this.enabled()) {
      return this.set({
        state: 'error',
        message: 'Updates are only available in a packaged build.',
      });
    }
    if (this.inFlight) return this.status;
    // A staged update stays offered until it is installed; re-checking would
    // only discard work already done.
    if (this.status.state === 'ready') return this.status;

    this.inFlight = true;
    this.set({ state: 'checking' });
    try {
      const context = this.installContext();
      this.log(
        `check(${manual ? 'manual' : 'scheduled'}) from ${context.version} ` +
          `electron=${context.electron} signed=${context.signedWithIdentity} ` +
          `writable=${context.bundleWritable} translocated=${context.translocated}`,
      );
      const manifest = await this.fetchManifest();
      const decision = decideUpdate(manifest, context);
      this.log(`manifest ${manifest.version} -> decision ${decision.kind}`);
      return await this.act(manifest, decision, manual);
    } catch (error) {
      return this.set({ state: 'error', message: describe(error) });
    } finally {
      this.inFlight = false;
    }
  }

  private async act(
    manifest: UpdateManifest,
    decision: UpdateDecision,
    manual: boolean,
  ): Promise<UpdateStatus> {
    const lastChecked = new Date().toISOString();

    switch (decision.kind) {
      case 'up-to-date':
        return this.set({ state: 'up-to-date', version: app.getVersion(), lastChecked });

      case 'full':
        this.fullDownloadUrl = decision.url;
        return this.set({
          state: 'manual',
          version: decision.version,
          notes: manifest.notes,
          url: decision.url,
          explanation: explainFull(decision.reason),
        });

      case 'delta': {
        // An automatic check may find an update but must not spend bandwidth on
        // it unasked; a manual check is the user asking.
        if (!manual && !this.autoDownloadAllowed()) {
          this.fullDownloadUrl = manifest.full.url;
          return this.set({
            state: 'manual',
            version: decision.version,
            notes: manifest.notes,
            url: manifest.full.url,
            explanation: 'An update is available. Choose Install to download it.',
          });
        }
        const payload = await this.download(decision.version, decision.payload);
        this.stage(decision.version, decision.payload.integrity, decision.payload.sha256, payload);
        return this.set({
          state: 'ready',
          version: decision.version,
          notes: manifest.notes,
          bytes: payload.length,
        });
      }
    }
  }

  /**
   * A delta is small enough that fetching it without asking is reasonable; the
   * full bundle never is. The distinction is the whole point of the feature.
   */
  private autoDownloadAllowed(): boolean {
    return true;
  }

  private async fetchManifest(): Promise<UpdateManifest> {
    const [body, signature] = await Promise.all([
      fetchBytes(MANIFEST_URL, MAX_MANIFEST_BYTES),
      fetchBytes(SIGNATURE_URL, 1024),
    ]);

    // Verify before parsing: an unsigned manifest's contents are not evidence
    // of anything and must not influence what happens next.
    if (!verifyManifestSignature(body, signature.toString('utf8'))) {
      throw new Error('The update manifest is not signed by this project.');
    }

    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('The update manifest is not valid JSON.');
    }

    const manifest = parseManifest(json);
    if (!manifest) throw new Error('The update manifest is malformed.');
    return manifest;
  }

  private async download(
    version: string,
    payload: { file: string; sha256: string; bytes: number },
  ): Promise<Buffer> {
    // The URL is built from the version and a filename the manifest proved is
    // not a path — the manifest never supplies a download URL directly.
    const url = `${DOWNLOAD_BASE}/v${version}/${encodeURIComponent(payload.file)}`;

    this.set({ state: 'downloading', version, received: 0, total: payload.bytes });
    const data = await fetchBytes(url, MAX_DELTA_BYTES, (received) => {
      this.set({ state: 'downloading', version, received, total: payload.bytes });
    });

    if (!checksumMatches(data, payload.sha256)) {
      throw new Error('The downloaded update did not match its checksum.');
    }
    return data;
  }

  private stage(version: string, integrity: string, sha256: string, payload: Buffer): void {
    const dir = path.join(this.supportDir, 'updates');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // Deliberately not named `*.asar`: Electron patches `fs` so that any path
    // containing `.asar` is resolved *inside* an archive, and writing one fails
    // with "Invalid package". The helper copies bytes to Contents/Resources and
    // never cares what the staging file was called.
    const asarPath = path.join(dir, `payload-${version}.bin`);
    fs.writeFileSync(asarPath, payload);

    const jobPath = path.join(dir, 'job.json');
    fs.writeFileSync(
      jobPath,
      JSON.stringify(
        {
          app_path: bundlePath(),
          asar_path: asarPath,
          integrity,
          sha256,
          version,
          wait_pid: process.pid,
          relaunch: true,
        },
        null,
        2,
      ),
    );

    this.staged = { jobPath, version };
  }

  /**
   * Hand off to the helper and quit. The helper waits for this process to exit
   * before touching the bundle, so the asar is never rewritten while mapped.
   */
  installAndRestart(): { ok: boolean; error?: string } {
    if (!this.staged) return { ok: false, error: 'No update has been downloaded yet.' };

    const helper = this.readerctlPath();
    if (!fs.existsSync(helper)) {
      return { ok: false, error: 'The update helper is missing from this build.' };
    }

    try {
      const child = spawn(helper, ['apply-update', '--job', this.staged.jobPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (error) {
      return { ok: false, error: describe(error) };
    }

    app.quit();
    return { ok: true };
  }

  /**
   * Open the full download in a browser.
   *
   * Takes no argument on purpose: the renderer never supplies a URL, so it
   * cannot use this as a general "open any link" primitive. The value comes from
   * a manifest this process already verified, and is re-checked against the
   * release host before it is handed to the OS.
   */
  openFullDownload(): { ok: boolean; error?: string } {
    const url = this.fullDownloadUrl;
    if (!url) return { ok: false, error: 'No download has been offered.' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'The download link is malformed.' };
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      return { ok: false, error: 'The download link does not point at the release host.' };
    }
    void shell.openExternal(parsed.toString());
    return { ok: true };
  }

  private installContext(): InstallContext {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      signedWithIdentity: hasDeveloperIdSignature(),
      bundleWritable: bundleWritable(),
      translocated: app.getPath('exe').includes('/AppTranslocation/'),
    };
  }

  private set(status: UpdateStatus): UpdateStatus {
    // Progress fires per chunk; log the transition into a state, not every tick.
    const repeated = status.state === 'downloading' && this.status.state === 'downloading';
    this.status = status;
    if (!repeated) this.log(describeStatus(status));
    this.onStatus(status);
    return status;
  }

  /**
   * Append one line to `update.log` in the support directory.
   *
   * An update path that fails silently is worse than none: the user believes
   * they are current while they are not. This records what was decided and why,
   * with no document content and no personal data — only versions, sizes, and
   * outcomes.
   */
  private log(line: string): void {
    try {
      fs.appendFileSync(
        path.join(this.supportDir, 'update.log'),
        `${new Date().toISOString()}  ${line}\n`,
      );
    } catch {
      /* diagnostics must never break the app */
    }
  }
}

/** `…/Focus Reader.app` from `…/Focus Reader.app/Contents/MacOS/Focus Reader`. */
function bundlePath(): string {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

function bundleWritable(): boolean {
  try {
    fs.accessSync(path.join(bundlePath(), 'Contents', 'Resources'), fs.constants.W_OK);
    fs.accessSync(path.join(bundlePath(), 'Contents', 'Info.plist'), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A delta re-signs the bundle ad-hoc, which would strip a real identity and,
 * under the hardened runtime, stop the app from launching. Detect that case so
 * such builds take the full download instead.
 */
function hasDeveloperIdSignature(): boolean {
  try {
    const out = execFileSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundlePath()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const team = /TeamIdentifier=(.+)/.exec(out)?.[1]?.trim();
    return Boolean(team) && team !== 'not set';
  } catch (error) {
    // codesign writes its report to stderr; execFileSync surfaces it here.
    const stderr = (error as { stderr?: Buffer | string })?.stderr;
    const text = typeof stderr === 'string' ? stderr : stderr?.toString('utf8') ?? '';
    const team = /TeamIdentifier=(.+)/.exec(text)?.[1]?.trim();
    // Unknown signing state is treated as signed: refusing to modify a bundle we
    // cannot classify is the safe direction to fail.
    if (!text) return true;
    return Boolean(team) && team !== 'not set';
  }
}

async function fetchBytes(
  url: string,
  limit: number,
  onProgress?: (received: number) => void,
): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
    headers: { accept: 'application/octet-stream' },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${new URL(url).pathname}`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error('The update payload is larger than expected.');

  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.length;
    // Enforce the cap while streaming, not after: a server that ignores
    // content-length should not be able to exhaust memory.
    if (received > limit) throw new Error('The update payload is larger than expected.');
    chunks.push(Buffer.from(chunk));
    onProgress?.(received);
  }
  return Buffer.concat(chunks);
}

function describeStatus(status: UpdateStatus): string {
  switch (status.state) {
    case 'downloading':
      return `downloading ${status.version} ${status.received}/${status.total}`;
    case 'ready':
      return `ready ${status.version} (${status.bytes} bytes staged)`;
    case 'manual':
      return `manual ${status.version}: ${status.explanation}`;
    case 'error':
      return `error: ${status.message}`;
    case 'up-to-date':
      return `up-to-date on ${status.version}`;
    default:
      return status.state;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'The update server did not respond.';
    return error.message;
  }
  return 'The update check failed.';
}
