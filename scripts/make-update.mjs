#!/usr/bin/env node
/**
 * Build the update payload for the current packaged app.
 *
 * Produces three release assets in `out/update`:
 *
 *   app-<version>.asar   the app's own code, ~744 KB of the 121 MB bundle
 *   update.json          version, checksums, and the asar integrity hash
 *   update.json.sig      detached Ed25519 signature over update.json's bytes
 *
 * The integrity hash is read from the freshly packaged Info.plist rather than
 * recomputed, so the value shipped to users is by construction the one Electron
 * Packager already validated for this exact asar.
 *
 *   npm run make && npm run build:update
 */
import { createHash, sign as signBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'out', 'Focus Reader-darwin-arm64', 'Focus Reader.app');
const OUT = path.join(ROOT, 'out', 'update');
const KEY_PATH =
  process.env.FR_UPDATE_KEY ??
  path.join(os.homedir(), '.config', 'focus-reader', 'update-signing-key.pem');

const REPO = 'hans5811/focus-reader';

function fail(message) {
  console.error(`make-update: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(APP)) fail(`no packaged app at ${path.relative(ROOT, APP)} — run npm run package`);
if (!fs.existsSync(KEY_PATH)) {
  fail(
    `no signing key at ${KEY_PATH}.\n` +
      'Run `node scripts/make-update-key.mjs`, or point FR_UPDATE_KEY at the key.\n' +
      'Publishing an unsigned manifest is not possible: installs would reject it.',
  );
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const plist = (key, file) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, file], {
    encoding: 'utf8',
  }).trim();

const INFO = path.join(APP, 'Contents/Info.plist');
// The Electron version this delta is valid for, read from the packaged
// framework rather than from package.json — this is the number the running app
// reports as process.versions.electron, so it is the one the check compares
// against. The app's own Info.plist does not record it.
const FRAMEWORK_INFO = path.join(
  APP,
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist',
);

const electronVersion = plist(':CFBundleVersion', FRAMEWORK_INFO);
if (!/^\d+\.\d+\.\d+/.test(electronVersion)) {
  fail(`could not read the packaged Electron version (got "${electronVersion}")`);
}
const integrity = plist(':ElectronAsarIntegrity:Resources/app.asar:hash', INFO);
if (!/^[0-9a-f]{64}$/.test(integrity)) {
  fail(`Info.plist has no usable asar integrity hash (got "${integrity}")`);
}

const asar = fs.readFileSync(path.join(APP, 'Contents/Resources/app.asar'));

// The full download must exist before a manifest can point at it. Name the file
// exactly rather than taking the first .zip in the directory: out/make
// accumulates one per version, and picking by readdir order silently published a
// manifest describing a *previous* release's bundle.
const zipDir = path.join(ROOT, 'out', 'make', 'zip', 'darwin', 'arm64');
const zipPath = path.join(zipDir, `Focus Reader-darwin-arm64-${version}.zip`);
if (!fs.existsSync(zipPath)) {
  fail(`no ${path.basename(zipPath)} in out/make — run npm run make at version ${version}`);
}
const zip = fs.readFileSync(zipPath);

const releaseZipName = `Focus-Reader-${version}-macOS-arm64.zip`;

const notes = process.env.FR_UPDATE_NOTES ?? `Focus Reader ${version}.`;

const manifest = {
  schema: 1,
  version,
  electron: electronVersion,
  notes,
  publishedAt: new Date().toISOString(),
  delta: {
    file: `app-${version}.asar`,
    bytes: asar.length,
    sha256: sha256(asar),
    integrity,
  },
  full: {
    url: `https://github.com/${REPO}/releases/download/v${version}/${releaseZipName}`,
    bytes: zip.length,
    sha256: sha256(zip),
  },
};

// Sign the exact bytes that will be published — never a re-serialisation, since
// the verifier checks these bytes and JSON round trips are not byte-stable.
const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
const signature = signBytes(null, body, fs.readFileSync(KEY_PATH, 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `app-${version}.asar`), asar);
fs.writeFileSync(path.join(OUT, 'update.json'), body);
fs.writeFileSync(path.join(OUT, 'update.json.sig'), signature.toString('base64'));
// Stage the zip under its published name too, so releasing is "upload
// everything in out/update" and there is no rename step for the manifest and
// the artifact to drift across.
fs.writeFileSync(path.join(OUT, releaseZipName), zip);

const pct = ((asar.length / zip.length) * 100).toFixed(2);
console.log(`update payload for ${version} -> ${path.relative(ROOT, OUT)}`);
console.log(`  app-${version}.asar   ${asar.length.toLocaleString()} bytes`);
console.log(`  full download        ${zip.length.toLocaleString()} bytes`);
console.log(`  a delta update moves ${pct}% of a full one`);
console.log(`\nPublish with:  gh release create v${version} ${path.relative(ROOT, OUT)}/* --title "Focus Reader ${version}"`);
