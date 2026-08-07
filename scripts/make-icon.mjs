#!/usr/bin/env node
/**
 * Generate `assets/icon.icns` — the Finder / Dock / About-panel app icon.
 *
 * The icon is drawn in code rather than checked in as a binary, for the same
 * reason the menu-bar glyph is (`src/main/tray.ts`): the mark *is* the product
 * idea — two context bars flanking a fixed pivot — so keeping it as source means
 * a change to it shows up in a diff, and the two never drift apart. The glyph
 * proportions below are the tray glyph's, expressed as fractions of the icon
 * body so both marks stay recognisably the same shape.
 *
 * Every size is rendered natively at 4x supersampling rather than downsampled
 * from 1024, because the 16pt and 32pt slots are where a rescaled pivot dot goes
 * muddy — and those are the sizes a menu-bar app is actually seen at.
 *
 * Depends only on Node's zlib and macOS's `iconutil`.
 */
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets');
const ICONSET = path.join(OUT_DIR, 'icon.iconset');
const ICNS = path.join(OUT_DIR, 'icon.icns');

/* ---------------------------------------------------------------- palette --
 * Mirrors the dark-scheme custom properties in src/renderer/overlay/overlay.css.
 * The icon is always dark: it reads as the app's own surface, not as something
 * that follows the system appearance. */
const INK_TOP = [38, 41, 56];
const INK_BOTTOM = [14, 15, 22];
const ACCENT = [255, 138, 76]; // --accent, the pivot
const CONTEXT = [236, 238, 245]; // --fg, the flanking context bars
const CONTEXT_ALPHA = 0.5;

/* --------------------------------------------------------------- geometry --
 * Apple's macOS app-icon grid: on a 1024 canvas the rounded body is 824 wide,
 * leaving a 100px margin that the system relies on for shadows and alignment.
 * Everything else is a fraction of that body. */
const BODY_FRACTION = 824 / 1024;
const SQUIRCLE_EXPONENT = 5; // superellipse; ~5 matches the macOS "squircle"

const FULL = { dot: 0.113, barHalfHeight: 0.045, barInner: 0.205, barOuter: 0.409 };

/**
 * At 16pt the body is under 13px across, so the bars land near one pixel tall
 * and antialiasing smears them into the pivot — the mark becomes an orange dot
 * on an unbroken grey band, which is not the idea it is meant to carry. The
 * small slot therefore drops the bars and states the pivot alone, the way Apple
 * simplifies its own small variants rather than shrinking the large one.
 */
const SIMPLE = { dot: 0.19, barHalfHeight: 0, barInner: 0, barOuter: 0 };
const SIMPLIFY_BELOW = 32;

const SUPERSAMPLE = 4;

const lerp = (a, b, t) => a + (b - a) * t;

/** Render one square RGBA icon of `size` pixels. */
function render(size) {
  const {
    dot: DOT_RADIUS,
    barHalfHeight: BAR_HALF_HEIGHT,
    barInner: BAR_INNER,
    barOuter: BAR_OUTER,
  } = size < SIMPLIFY_BELOW ? SIMPLE : FULL;
  const pixels = Buffer.alloc(size * size * 4);
  const body = size * BODY_FRACTION;
  const half = body / 2;
  const centre = size / 2;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // Sample at subpixel centres, in body-relative units where the body
          // spans [-0.5, 0.5] on both axes.
          const x = (px + (sx + 0.5) * step - centre) / body;
          const y = (py + (sy + 0.5) * step - centre) / body;

          // Outside the squircle the icon is transparent.
          const u = Math.abs(x / 0.5);
          const v = Math.abs(y / 0.5);
          if (u ** SQUIRCLE_EXPONENT + v ** SQUIRCLE_EXPONENT > 1) continue;

          // Ink gradient, top to bottom of the body.
          const t = Math.min(1, Math.max(0, y + 0.5));
          let sr = lerp(INK_TOP[0], INK_BOTTOM[0], t);
          let sg = lerp(INK_TOP[1], INK_BOTTOM[1], t);
          let sb = lerp(INK_TOP[2], INK_BOTTOM[2], t);

          if (Math.hypot(x, y) <= DOT_RADIUS) {
            // The pivot: fully opaque accent, the one thing the eye lands on.
            [sr, sg, sb] = ACCENT;
          } else if (
            Math.abs(y) <= BAR_HALF_HEIGHT &&
            Math.abs(x) >= BAR_INNER &&
            Math.abs(x) <= BAR_OUTER
          ) {
            // Context bars, quieter than the pivot. Stadium caps come from
            // rounding the ends rather than cutting them square.
            sr = lerp(sr, CONTEXT[0], CONTEXT_ALPHA);
            sg = lerp(sg, CONTEXT[1], CONTEXT_ALPHA);
            sb = lerp(sb, CONTEXT[2], CONTEXT_ALPHA);
          } else {
            const capX = Math.min(BAR_OUTER, Math.max(BAR_INNER, Math.abs(x)));
            const inCap =
              Math.abs(x) > BAR_INNER - BAR_HALF_HEIGHT &&
              Math.abs(x) < BAR_OUTER + BAR_HALF_HEIGHT &&
              Math.hypot(Math.abs(x) - capX, y) <= BAR_HALF_HEIGHT;
            if (inCap) {
              sr = lerp(sr, CONTEXT[0], CONTEXT_ALPHA);
              sg = lerp(sg, CONTEXT[1], CONTEXT_ALPHA);
              sb = lerp(sb, CONTEXT[2], CONTEXT_ALPHA);
            }
          }

          r += sr;
          g += sg;
          b += sb;
          a += 1;
        }
      }

      if (a === 0) continue;
      const i = (py * size + px) * 4;
      // Coverage-weighted colour: divide by covered samples, not by all of them,
      // so edge pixels keep their full colour and only lose alpha.
      pixels[i] = Math.round(r / a);
      pixels[i + 1] = Math.round(g / a);
      pixels[i + 2] = Math.round(b / a);
      pixels[i + 3] = Math.round((a / samples) * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------ PNG encoder --
 * A minimal RGBA-only encoder. Writing ~40 lines here is cheaper than adding a
 * dependency to a build that otherwise has none. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ build -- */
// The slots `iconutil` expects. Several share a pixel size (a 32pt @1x and a
// 16pt @2x are both 32px), so each size is rendered once and written twice.
const SLOTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

const cache = new Map();
for (const [name, size] of SLOTS) {
  if (!cache.has(size)) cache.set(size, encodePng(render(size), size));
  fs.writeFileSync(path.join(ICONSET, name), cache.get(size));
}

execFileSync('iconutil', ['--convert', 'icns', ICONSET, '--output', ICNS], { stdio: 'inherit' });
fs.rmSync(ICONSET, { recursive: true, force: true });

console.log(`icon → ${path.relative(ROOT, ICNS)} (${fs.statSync(ICNS).size} bytes)`);
