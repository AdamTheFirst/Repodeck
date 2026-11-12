// Generates installer/repodeck.ico (PNG-compressed entries, 16-256 px) from a simple
// vector description, with 4x supersampling. Run: node scripts/make-icon.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function render(size) {
  const S = 4; const W = size * S;
  const px = new Float32Array(W * W * 4);
  const k = W / 26; // design grid is 26x26 (same as ui/icon.svg)
  const set = (x, y, c, a = 1) => { const i = (y * W + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a; };
  const mint = [0x45, 0xd6, 0xb0]; const ink = [0x06, 0x23, 0x1b];
  const card = (x0, y0, size, r, c, a) => {
    for (let y = Math.floor(y0 * k); y < (y0 + size) * k; y++) for (let x = Math.floor(x0 * k); x < (x0 + size) * k; x++) {
      const gx = x / k - x0; const gy = y / k - y0;
      const dx = Math.max(r - gx, 0, gx - (size - r)); const dy = Math.max(r - gy, 0, gy - (size - r));
      if (dx * dx + dy * dy <= r * r) set(x, y, c, a);
    }
  };
  const disc = (cx, cy, rad, c) => { for (let y = Math.floor((cy - rad) * k); y <= (cy + rad) * k; y++) for (let x = Math.floor((cx - rad) * k); x <= (cx + rad) * k; x++) { if (x < 0 || y < 0 || x >= W || y >= W) continue; const ddx = x / k - cx; const ddy = y / k - cy; if (ddx * ddx + ddy * ddy <= rad * rad) set(x, y, c); } };
  const stroke = (pts, w, c) => { for (let i = 0; i < pts.length - 1; i++) { const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1]; const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 8); for (let q = 0; q <= n; q++) disc(x0 + (x1 - x0) * q / n, y0 + (y1 - y0) * q / n, w / 2, c); } };
  card(2, 2, 16, 5, mint, 0.38);
  card(8, 8, 16, 5, mint, 1);
  stroke([[13.5, 12.5], [13.5, 19.5]], 1.8, ink);
  const curve = []; for (let t = 0; t <= 1.0001; t += 0.05) { const p0 = [13.5, 16.5]; const c1 = [13.5, 13.9]; const c2 = [18.5, 15.1]; const p1 = [18.5, 12.5]; const u = 1 - t; curve.push([u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p1[0], u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p1[1]]); }
  stroke(curve, 1.8, ink);
  disc(13.5, 12.3, 1.6, ink); disc(13.5, 19.7, 1.6, ink); disc(18.5, 12.3, 1.6, ink);
  // downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let rr = 0; let gg = 0; let bb = 0; let aa = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) { const i = ((y * S + sy) * W + (x * S + sx)) * 4; const a = px[i + 3]; rr += px[i] * a; gg += px[i + 1] * a; bb += px[i + 2] * a; aa += a; }
    const o = (y * size + x) * 4;
    out[o] = aa ? Math.round(rr / aa) : 0; out[o + 1] = aa ? Math.round(gg / aa) : 0; out[o + 2] = aa ? Math.round(bb / aa) : 0; out[o + 3] = Math.round((aa / (S * S)) * 255);
  }
  return out;
}

function crc32(buf) { let c; const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let crc = 0xffffffff; for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s)));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const o = i * 16;
  dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s; dir[o + 2] = 0; dir[o + 3] = 0;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(images[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += images[i].length;
});
const outFile = path.join(__dirname, '..', 'installer', 'repodeck.ico');
fs.writeFileSync(outFile, Buffer.concat([header, dir, ...images]));
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'icon-32.png'), images[2]);
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'icon-256.png'), images[6]);
console.log(`Wrote ${outFile}`);
