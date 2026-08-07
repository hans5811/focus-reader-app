/**
 * Update manifest and the decision of *how* to update.
 *
 * The app is ~121 MB, of which ~744 KB is its own code; the rest is the Electron
 * runtime. So a release that changes only app code can be delivered by replacing
 * one file inside the bundle instead of shipping the bundle again. Everything
 * that decides whether that is safe lives here, with no Electron and no I/O, so
 * the rules are testable rather than discovered in production.
 */

export interface UpdatePayload {
  /** Asset filename, resolved against the release's download base. */
  file: string;
  bytes: number;
  /** SHA-256 of the file as downloaded — guards the transfer. */
  sha256: string;
}

export interface DeltaPayload extends UpdatePayload {
  /**
   * SHA-256 of the asar's header string, which is what Electron compares
   * against `ElectronAsarIntegrity` in Info.plist. Installing without writing
   * this value back makes the app abort at startup, so it travels with the
   * payload rather than being recomputed on the user's machine.
   */
  integrity: string;
}

export interface UpdateManifest {
  schema: 1;
  version: string;
  /**
   * The Electron version this build runs on. A delta only replaces app code, so
   * it is valid exclusively for an install already on this runtime.
   */
  electron: string;
  notes: string;
  publishedAt: string;
  delta?: DeltaPayload;
  full: { url: string; bytes: number; sha256: string };
}

export type UpdateDecision =
  | { kind: 'up-to-date' }
  | { kind: 'delta'; payload: DeltaPayload; version: string }
  | { kind: 'full'; url: string; version: string; reason: FullReason };

export type FullReason =
  | 'electron-changed'
  | 'no-delta-published'
  | 'signed-build'
  | 'bundle-not-writable'
  | 'translocated';

/** What the running app knows about itself when it asks. */
export interface InstallContext {
  version: string;
  electron: string;
  /**
   * True when the bundle carries a real Developer ID signature. A delta rewrites
   * the bundle and can only re-sign it ad-hoc, which would *downgrade* a signed
   * build into one Gatekeeper trusts less — and under the hardened runtime it
   * would not launch at all. Such builds must take the full, notarized path.
   */
  signedWithIdentity: boolean;
  bundleWritable: boolean;
  /**
   * macOS runs quarantined apps from a read-only randomised mount. Writing there
   * is pointless: the changes evaporate, and the app is not where the user
   * thinks it is.
   */
  translocated: boolean;
}

const NUMERIC = /^\d+$/;

/**
 * Compare two dotted versions. Prerelease suffixes sort before their release
 * (`1.1.0-beta.1` < `1.1.0`), matching how the tags are actually cut.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a);
  const [bCore, bPre] = splitPrerelease(b);

  const ap = aCore.split('.');
  const bp = bCore.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = Number(ap[i] ?? 0);
    const y = Number(bp[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const c = (ap[i] ?? '').localeCompare(bp[i] ?? '');
      if (c !== 0) return c < 0 ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }

  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1; // a release outranks its own prerelease
  if (bPre === undefined) return -1;
  return comparePrerelease(aPre, bPre);
}

function splitPrerelease(v: string): [string, string | undefined] {
  const i = v.indexOf('-');
  return i === -1 ? [v, undefined] : [v.slice(0, i), v.slice(i + 1)];
}

function comparePrerelease(a: string, b: string): number {
  const ap = a.split('.');
  const bp = b.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (NUMERIC.test(x) && NUMERIC.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Reject anything malformed before it reaches the network or the filesystem.
 * A signature proves the manifest came from us; this proves it makes sense.
 */
export function parseManifest(input: unknown): UpdateManifest | null {
  if (typeof input !== 'object' || input === null) return null;
  const m = input as Record<string, unknown>;

  if (m.schema !== 1) return null;
  if (typeof m.version !== 'string' || m.version.length === 0) return null;
  if (typeof m.electron !== 'string' || m.electron.length === 0) return null;
  if (typeof m.notes !== 'string') return null;
  if (typeof m.publishedAt !== 'string') return null;

  const full = m.full as Record<string, unknown> | undefined;
  if (
    !full ||
    typeof full.url !== 'string' ||
    !full.url.startsWith('https://') ||
    typeof full.bytes !== 'number' ||
    typeof full.sha256 !== 'string' ||
    !SHA256.test(full.sha256)
  ) {
    return null;
  }

  let delta: DeltaPayload | undefined;
  if (m.delta !== undefined) {
    const d = m.delta as Record<string, unknown>;
    if (
      typeof d.file !== 'string' ||
      // A filename, never a path or a URL: this is joined onto a release base,
      // and `../` or an absolute URL would redirect the download elsewhere.
      d.file.includes('/') ||
      d.file.includes('\\') ||
      typeof d.bytes !== 'number' ||
      d.bytes <= 0 ||
      typeof d.sha256 !== 'string' ||
      !SHA256.test(d.sha256) ||
      typeof d.integrity !== 'string' ||
      !SHA256.test(d.integrity)
    ) {
      return null;
    }
    delta = { file: d.file, bytes: d.bytes, sha256: d.sha256, integrity: d.integrity };
  }

  return {
    schema: 1,
    version: m.version,
    electron: m.electron,
    notes: m.notes,
    publishedAt: m.publishedAt,
    full: { url: full.url, bytes: full.bytes, sha256: full.sha256 },
    ...(delta ? { delta } : {}),
  };
}

/**
 * Decide how — or whether — to move from `install` to `manifest`.
 *
 * Every path that cannot be applied in place still returns an answer the UI can
 * act on, with the reason, rather than silently offering nothing.
 */
export function decideUpdate(
  manifest: UpdateManifest,
  install: InstallContext,
): UpdateDecision {
  if (compareVersions(manifest.version, install.version) <= 0) {
    return { kind: 'up-to-date' };
  }

  const full = (reason: FullReason): UpdateDecision => ({
    kind: 'full',
    url: manifest.full.url,
    version: manifest.version,
    reason,
  });

  if (!manifest.delta) return full('no-delta-published');
  // A delta carries app code only; a different runtime needs the whole bundle.
  if (manifest.electron !== install.electron) return full('electron-changed');
  if (install.signedWithIdentity) return full('signed-build');
  if (install.translocated) return full('translocated');
  if (!install.bundleWritable) return full('bundle-not-writable');

  return { kind: 'delta', payload: manifest.delta, version: manifest.version };
}

/** One sentence explaining a full-download decision, for the UI. */
export function explainFull(reason: FullReason): string {
  switch (reason) {
    case 'electron-changed':
      return 'This release upgrades the Electron runtime, so the whole app has to come down.';
    case 'no-delta-published':
      return 'This release did not publish a small update.';
    case 'signed-build':
      return 'This copy carries a Developer ID signature, which a small update cannot preserve.';
    case 'bundle-not-writable':
      return 'Focus Reader cannot write to its own bundle — move it to Applications and try again.';
    case 'translocated':
      return 'macOS is running this copy from a temporary read-only location. Move it to Applications first.';
  }
}
