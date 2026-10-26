// Draws the app icons for Add to Home Screen (web/public/icon-180.png, icon-192.png, icon-512.png): the Jobs tile's
// briefcase in white on the accent blue, full bleed (iOS rounds the corners itself). No dependencies: the lines are
// drawn by distance to each segment with 4x4 supersampling, and the PNG is written with node:zlib.
//   node scripts/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { repoPath } from '../tools/paths.js';

export const BACKGROUND = [0x1a, 0x52, 0x76]; // --accent in web/src/styles.css (light)
const LINE = [0xff, 0xff, 0xff];
const STROKE = 2.6; // in tile units, as on the Home page
const INSET = 0.2; // the share of the icon left clear on each side

/** Points along a circular arc (degrees, clockwise on screen) from a0 to a1. */
const arc = (cx, cy, r, a0, a1, steps = 8) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// The briefcase from HomePage.jsx's jobs icon, in its 48 x 48 box: body (rounded rectangle), handle, band, clasp.
const LINES = [
  [...arc(10, 18, 4, 180, 270), ...arc(38, 18, 4, 270, 360), ...arc(38, 34, 4, 0, 90), ...arc(10, 34, 4, 90, 180), [6, 18]],
  [[17, 14], ...arc(20, 11, 3, 180, 270), ...arc(28, 11, 3, 270, 360), [31, 14]],
  [[6, 24], [42, 24]],
  [[21, 24], [21, 28], [27, 28], [27, 24]],
];
const BOX = { x0: 6, x1: 42, y0: 8, y1: 38 }; // what the lines span

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** RGB pixels for a size x size icon. */
export function drawIcon(size) {
  const scale = (size * (1 - 2 * INSET)) / Math.max(BOX.x1 - BOX.x0, BOX.y1 - BOX.y0);
  const cx = (BOX.x0 + BOX.x1) / 2;
  const cy = (BOX.y0 + BOX.y1) / 2;
  const toIcon = ([x, y]) => [size / 2 + (x - cx) * scale, size / 2 + (y - cy) * scale];
  const segments = LINES.flatMap((line) => line.slice(1).map((p, i) => [toIcon(line[i]), toIcon(p)]));
  const half = (STROKE * scale) / 2;
  const pixels = Buffer.alloc(size * size * 3);
  const SAMPLES = 4;
  for (let y = 0; y < size; y++) {
    // Only the segments within reach of this row matter.
    const near = segments.filter(([a, b]) => Math.min(a[1], b[1]) - half - 1 <= y && Math.max(a[1], b[1]) + half + 1 >= y);
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (near.some(([a, b]) => distanceToSegment(px, py, a, b) <= half)) covered++;
        }
      }
      const a = covered / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) pixels[(y * size + x) * 3 + c] = Math.round(BACKGROUND[c] * (1 - a) + LINE[c] * a);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG from size x size pixels. */
export function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [180, 192, 512];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const size of ICON_SIZES) {
    const path = repoPath('web', 'public', `icon-${size}.png`);
    writeFileSync(path, encodePng(size, drawIcon(size)));
    console.log(`Wrote ${path}`);
  }
}
