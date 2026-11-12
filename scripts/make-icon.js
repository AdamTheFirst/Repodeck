// Generates installer/git-helper.ico (PNG-compressed entries, 16-256 px) from a simple
// vector description, with 4x supersampling. Run: node scripts/make-icon.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function render(size) {
  const S = 4; const W = size * S;
  const px = new Float32Array(W * W * 4);
  const k = W / 64; // design grid is 64x64 (same as ui/icon.svg)
  const set = (x, y, c) => { const i = (y * W + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 1; };
  const bg = [0x2f, 0x6f, 0x5e]; const fg = [255, 255, 255];
  // rounded square
  const r = 14 * k;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = Math.max(r - x, 0, x - (W - 1 - r)); const dy = Math.max(r - y, 0, y - (W - 1 - r));
    if (dx * dx + dy * dy <= r * r) set(x, y, bg);
  }
  const disc = (cx, cy, rad) => { for (let y = Math.floor((cy - rad) * k); y <= (cy + rad) * k; y++) for (let x = Math.floor((cx - rad) * k); x <= (cx + rad) * k; x++) { if (x < 0 || y < 0 || x >= W || y >= W) continue; const ddx = x / k - cx; const ddy = y / k - cy; if (ddx * ddx + ddy * ddy <= rad * rad) set(x, y, fg); } };
  const stroke = (pts, w) => { for (let i = 0; i < pts.length - 1; i++) { const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1]; const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4); for (let s = 0; s <= n; s++) disc(x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n, w / 2); } };
  stroke([[22, 14], [22, 50]], 5);
  const curve = []; for (let t = 0; t <= 1.0001; t += 0.05) { const a = [22, 34]; const c1 = [22, 24]; const c2 = [42, 28]; const b = [42, 18]; const u = 1 - t; curve.push([u ** 3 * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * b[0], u ** 3 * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * b[1]]); }
  stroke(curve, 5);
  disc(22, 14, 6); disc(22, 50, 6); disc(42, 18, 6);
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
const outFile = path.join(__dirname, '..', 'installer', 'git-helper.ico');
fs.writeFileSync(outFile, Buffer.concat([header, dir, ...images]));
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'icon-32.png'), images[2]);
console.log(`Wrote ${outFile}`);
