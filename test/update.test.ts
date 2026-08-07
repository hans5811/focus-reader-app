import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signWith } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  decideUpdate,
  explainFull,
  parseManifest,
  type InstallContext,
  type UpdateManifest,
} from '@shared/update/manifest';
import { checksumMatches, sha256, verifyManifestSignature } from '@shared/update/verify';

const MANIFEST: UpdateManifest = {
  schema: 1,
  version: '1.0.1',
  electron: '43.3.0',
  notes: 'Fixes the pivot on narrow overlays.',
  publishedAt: '2026-08-07T00:00:00.000Z',
  delta: {
    file: 'app-1.0.1.asar',
    bytes: 761_689,
    sha256: 'a'.repeat(64),
    integrity: 'b'.repeat(64),
  },
  full: {
    url: 'https://github.com/hans5811/focus-reader/releases/download/v1.0.1/Focus-Reader.zip',
    bytes: 121_057_093,
    sha256: 'c'.repeat(64),
  },
};

const INSTALL: InstallContext = {
  version: '1.0.0',
  electron: '43.3.0',
  signedWithIdentity: false,
  bundleWritable: true,
  translocated: false,
};

describe('version comparison', () => {
  it('orders releases numerically, not lexically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.1.1', '1.1')).toBe(1);
  });

  it('sorts a prerelease below its own release', () => {
    expect(compareVersions('1.1.0-beta.1', '1.1.0')).toBe(-1);
    expect(compareVersions('1.1.0-beta.2', '1.1.0-beta.10')).toBe(-1);
    expect(compareVersions('1.1.0-alpha', '1.1.0-beta')).toBe(-1);
  });
});

describe('manifest parsing rejects anything malformed', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(MANIFEST)))).toEqual(MANIFEST);
  });

  it('rejects an unknown schema version', () => {
    expect(parseManifest({ ...MANIFEST, schema: 2 })).toBeNull();
  });

  it('refuses a delta filename that could redirect the download', () => {
    for (const file of ['../evil.asar', '/etc/passwd', 'https://evil.test/a.asar', 'a\\b']) {
      expect(parseManifest({ ...MANIFEST, delta: { ...MANIFEST.delta, file } })).toBeNull();
    }
  });

  it('refuses a non-https full-download url', () => {
    expect(
      parseManifest({ ...MANIFEST, full: { ...MANIFEST.full, url: 'http://evil.test/a.zip' } }),
    ).toBeNull();
  });

  it('refuses malformed digests', () => {
    expect(
      parseManifest({ ...MANIFEST, delta: { ...MANIFEST.delta, sha256: 'nope' } }),
    ).toBeNull();
    expect(
      parseManifest({ ...MANIFEST, delta: { ...MANIFEST.delta, integrity: 'B'.repeat(64) } }),
    ).toBeNull();
  });

  it('accepts a manifest with no delta at all', () => {
    const { delta: _delta, ...noDelta } = MANIFEST;
    expect(parseManifest(noDelta)?.delta).toBeUndefined();
  });
});

describe('choosing between a 744 KB delta and a 121 MB download', () => {
  it('takes the delta when nothing stands in the way', () => {
    const d = decideUpdate(MANIFEST, INSTALL);
    expect(d.kind).toBe('delta');
    expect(d.kind === 'delta' && d.payload.file).toBe('app-1.0.1.asar');
  });

  it('reports up-to-date for the same or an older release', () => {
    expect(decideUpdate(MANIFEST, { ...INSTALL, version: '1.0.1' }).kind).toBe('up-to-date');
    expect(decideUpdate(MANIFEST, { ...INSTALL, version: '2.0.0' }).kind).toBe('up-to-date');
  });

  it('falls back to the full download when the runtime itself changed', () => {
    const d = decideUpdate(MANIFEST, { ...INSTALL, electron: '42.0.0' });
    expect(d).toMatchObject({ kind: 'full', reason: 'electron-changed' });
  });

  it('never rewrites a Developer ID bundle, which it could only re-sign ad-hoc', () => {
    const d = decideUpdate(MANIFEST, { ...INSTALL, signedWithIdentity: true });
    expect(d).toMatchObject({ kind: 'full', reason: 'signed-build' });
  });

  it('refuses to write into a translocated or read-only bundle', () => {
    expect(decideUpdate(MANIFEST, { ...INSTALL, translocated: true })).toMatchObject({
      reason: 'translocated',
    });
    expect(decideUpdate(MANIFEST, { ...INSTALL, bundleWritable: false })).toMatchObject({
      reason: 'bundle-not-writable',
    });
  });

  it('explains every fallback reason it can produce', () => {
    const reasons = [
      'electron-changed',
      'no-delta-published',
      'signed-build',
      'bundle-not-writable',
      'translocated',
    ] as const;
    for (const r of reasons) expect(explainFull(r).length).toBeGreaterThan(20);
  });
});

describe('signature verification', () => {
  const bytes = Buffer.from(JSON.stringify(MANIFEST), 'utf8');

  // The app ships one public key; sign with the matching private half from the
  // repo's own generator output so the test exercises the real key material.
  const keyPath = path.join(os.homedir(), '.config', 'focus-reader', 'update-signing-key.pem');
  const haveKey = fs.existsSync(keyPath);

  it.runIf(haveKey)('accepts a manifest signed by the real release key', () => {
    const sig = signWith(null, bytes, fs.readFileSync(keyPath, 'utf8')).toString('base64');
    expect(verifyManifestSignature(bytes, sig)).toBe(true);
  });

  it.runIf(haveKey)('rejects a manifest whose bytes were altered after signing', () => {
    const sig = signWith(null, bytes, fs.readFileSync(keyPath, 'utf8')).toString('base64');
    const tampered = Buffer.from(
      JSON.stringify({ ...MANIFEST, version: '9.9.9' }),
      'utf8',
    );
    expect(verifyManifestSignature(tampered, sig)).toBe(false);
  });

  it('rejects a signature from a different key, however well-formed', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = signWith(null, bytes, privateKey).toString('base64');
    expect(verifyManifestSignature(bytes, forged)).toBe(false);
  });

  it('rejects junk signatures without throwing', () => {
    for (const s of ['', 'not base64!!', 'AAAA', 'A'.repeat(200)]) {
      expect(verifyManifestSignature(bytes, s)).toBe(false);
    }
  });
});

describe('payload checksums', () => {
  it('accepts the digest of the exact bytes', () => {
    const data = Buffer.from('the asar payload');
    expect(checksumMatches(data, sha256(data))).toBe(true);
  });

  it('rejects a single flipped byte', () => {
    const data = Buffer.from('the asar payload');
    const digest = sha256(data);
    expect(checksumMatches(Buffer.from('the asar payloae'), digest)).toBe(false);
  });

  it('rejects a truncated digest rather than matching a prefix', () => {
    const data = Buffer.from('the asar payload');
    expect(checksumMatches(data, sha256(data).slice(0, 32))).toBe(false);
  });
});
