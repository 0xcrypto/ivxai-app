/* Renders the PNG app icons from scratch — no image libraries, no binaries.
   Run with: node tools/make-icons.mjs   (only needed if the artwork changes)

   These exist so the PWA can be installed; the app itself shows a wordmark,
   not a logo. The mark is a plain "N" in the neutral ramp. */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── signed distance helpers (units are fractions of the icon size) ── */

const roundedRect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
};

const mix = (a, b, t) => a + (b - a) * t;

const segment = (px, py, ax, ay, bx, by, halfWidth) => {
  // Distance to a thick line segment: the building block of the letterform.
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.min(Math.max((wx * vx + wy * vy) / (vx * vx + vy * vy), 0), 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - halfWidth;
};

function render(size, { padding = 0 } = {}) {
  const S = 3;                                          // supersampling factor
  const out = Buffer.alloc(size * size * 4);
  const inset = padding;                                // maskable icons need a safe area
  const scale = 1 - inset * 2;

  const BG = [0x0a, 0x0a, 0x0a];                        // --n-950
  const FG = [0xfa, 0xfa, 0xfa];                        // --n-50

  // "N": two uprights joined by a diagonal.
  const STROKE = 0.085;
  const TOP = 0.29, BOT = 0.71, L = 0.32, R = 0.68;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const px = (u - inset) / scale;
          const py = (v - inset) / scale;

          const plate = roundedRect(px, py, 0.5, 0.5, 0.5, 0.5, 0.22);
          const plateA = Math.min(Math.max(0.5 - plate * size * scale, 0), 1);

          const glyph = Math.min(
            segment(px, py, L, TOP, L, BOT, STROKE / 2),
            segment(px, py, R, TOP, R, BOT, STROKE / 2),
            segment(px, py, L, TOP, R, BOT, STROKE / 2)
          );
          const glyphA = Math.min(Math.max(0.5 - glyph * size * scale, 0), 1) * plateA;

          r += mix(BG[0], FG[0], glyphA) * plateA;
          g += mix(BG[1], FG[1], glyphA) * plateA;
          b += mix(BG[2], FG[2], glyphA) * plateA;
          a += plateA;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, out);
}

writeFileSync('public/icons/icon-192.png', render(192));
writeFileSync('public/icons/icon-512.png', render(512));
writeFileSync('public/icons/maskable-512.png', render(512, { padding: 0.1 }));
console.log('wrote public/icons/*.png');
