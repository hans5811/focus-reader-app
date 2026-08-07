import { createPublicKey, createHash, verify as verifySignature } from 'node:crypto';
import { UPDATE_PUBLIC_KEY_SPKI_BASE64 } from './public-key';

/**
 * Signature and checksum checks for the update channel.
 *
 * Kept apart from the network code so the trust decisions can be tested against
 * forged input directly, rather than only through a live download.
 */

let cachedKey: ReturnType<typeof createPublicKey> | null = null;

function publicKey() {
  if (!cachedKey) {
    cachedKey = createPublicKey({
      key: Buffer.from(UPDATE_PUBLIC_KEY_SPKI_BASE64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return cachedKey;
}

/**
 * Verify a detached Ed25519 signature over the manifest's exact bytes.
 *
 * The raw bytes are what is signed, never a re-serialised object: JSON round
 * trips do not preserve key order or whitespace, so signing the parsed form
 * would make valid manifests fail and invite someone to "fix" it by trusting
 * unsigned input.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBase64: string,
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), 'base64');
  } catch {
    return false;
  }
  // Ed25519 signatures are always 64 bytes; anything else is not worth passing
  // to the verifier.
  if (signature.length !== 64) return false;

  try {
    return verifySignature(null, manifestBytes, publicKey(), signature);
  } catch {
    return false;
  }
}

/** Constant-time-ish comparison of a computed digest against an expected one. */
export function checksumMatches(data: Buffer, expectedHex: string): boolean {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
