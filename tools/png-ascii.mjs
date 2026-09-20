// Temporary probe: decode PNGs (8-bit, non-interlaced) and render them as ASCII
// so two icon files can be compared as text in a terminal.
import fs from 'fs';
import zlib from 'zlib';

function decodePng(buf) {
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported png depth=${depth} interlace=${interlace}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`unsupported color type ${color}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  // Normalise to RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, b, a = 255;
    if (color === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (color === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (color === 3) { const p = out[i]; r = palette[p * 3]; g = palette[p * 3 + 1]; b = palette[p * 3 + 2]; a = trns && p < trns.length ? trns[p] : 255; }
    else if (color === 0) { r = g = b = out[i]; }
    else { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, rgba };
}

const RAMP = ' .:-=+*#%@';

function ascii(img, cols = 28, rows = 14) {
  let lines = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const sx = Math.min(img.w - 1, Math.floor((rx + 0.5) * img.w / cols));
      const sy = Math.min(img.h - 1, Math.floor((ry + 0.5) * img.h / rows));
      const i = (sy * img.w + sx) * 4;
      if (img.rgba[i + 3] < 32) { line += ' '; continue; }
      const lum = (0.299 * img.rgba[i] + 0.587 * img.rgba[i + 1] + 0.114 * img.rgba[i + 2]) / 255;
      line += RAMP[Math.min(RAMP.length - 1, Math.round(lum * (RAMP.length - 1)))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function stats(img) {
  let r = 0, g = 0, b = 0, n = 0, opaque = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    if (img.rgba[i * 4 + 3] < 32) continue;
    opaque++; r += img.rgba[i * 4]; g += img.rgba[i * 4 + 1]; b += img.rgba[i * 4 + 2]; n++;
  }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return `avg #${hex(r)}${hex(g)}${hex(b)} opaque=${(opaque / (img.w * img.h) * 100).toFixed(0)}%`;
}

function fromIco(path) {
  const buf = fs.readFileSync(path);
  const off = buf.readUInt32LE(6 + 12);
  return decodePng(buf.slice(off, off + buf.readUInt32LE(6 + 8)));
}

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((p) => [p, p.endsWith('.ico') ? fromIco(p) : decodePng(fs.readFileSync(p))])
  : [
    ['desktop icons/icon.png            ', decodePng(fs.readFileSync('src-tauri/icons/icon.png'))],
    ['desktop icons/icon.ico (256 png)  ', fromIco('src-tauri/icons/icon.ico')],
    ['android mipmap-xxxhdpi/ic_launcher', decodePng(fs.readFileSync('src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'))],
  ];
for (const [name, img] of targets) {
  console.log(`\n=== ${name} ${img.w}x${img.h} — ${stats(img)} ===`);
  console.log(ascii(img));
}
