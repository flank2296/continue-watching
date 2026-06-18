// Minimal dependency-free PNG generator for the extension icons.
// Draws a red rounded square with a white play triangle. Run: node tools/gen-icons.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function png(size) {
  const W = size, H = size;
  const bg = [0xe5, 0x09, 0x14];
  const raw = Buffer.alloc(H * (1 + W * 4));
  const r = size * 0.2;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const i = y * (1 + W * 4) + 1 + x * 4;
      // rounded-corner alpha
      let alpha = 255;
      const cx = Math.min(x, W - 1 - x);
      const cy = Math.min(y, H - 1 - y);
      if (cx < r && cy < r) {
        const dx = r - cx, dy = r - cy;
        if (dx * dx + dy * dy > r * r) alpha = 0;
      }
      // white play triangle
      let white = false;
      const tx0 = W * 0.36, tx1 = W * 0.70, tyc = H * 0.5;
      if (x >= tx0 && x <= tx1) {
        const frac = (x - tx0) / (tx1 - tx0);
        const half = (1 - frac) * (H * 0.22);
        if (Math.abs(y - tyc) <= half) white = true;
      }
      raw[i] = white ? 255 : bg[0];
      raw[i + 1] = white ? 255 : bg[1];
      raw[i + 2] = white ? 255 : bg[2];
      raw[i + 3] = alpha;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png(s));
  console.log('wrote', `icon${s}.png`);
}
