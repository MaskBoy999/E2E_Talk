// Generates src-tauri/icons/icon.png (512px) and icon.ico (256px) with no
// external dependencies. Run: `node tools/box/make-icons.mjs`.
//
// For a full platform icon set (icns, android/ios densities) install the Tauri
// CLI and run `cargo tauri icon static/icons/icon-192.svg`.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../src-tauri/icons');

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePng(size, fn) {
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (stride + 1);
        raw[row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const [r, g, b, a] = fn(x, y, size);
            const o = row + 1 + x * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // RGBA
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const ACCENT_GOLD = [212, 168, 67, 255];
const ACCENT_CYAN = [79, 195, 247, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    if (cx === x && cy === y) return true;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function dist(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// Two interlocking rings on a dark background
function icon(x, y, size) {
    const s = size / 512;
    
    // Clipping to round square (squircle-like)
    if (!inRoundRect(x, y, 26 * s, 26 * s, 486 * s, 486 * s, 108 * s)) return CLEAR;
    
    // Center of the icon (with slight offset for visual balance)
    const cx = 256 * s;
    const cy = 256 * s;
    
    // Gold ring center (top-right)
    const goldCx = 268 * s;
    const goldCy = 238 * s;
    
    // Cyan ring center (bottom-left)
    const cyanCx = 244 * s;
    const cyanCy = 274 * s;
    
    // Ring radius and thickness
    const ringR = 72 * s;
    const ringStroke = 18 * s;
    
    // Small center dot radius
    const dotR = 26 * s;
    
    // White info icon element (right side)
    const infoX = 310 * s;
    const infoYBase = 244 * s;
    
    // Check if inside gold ring's stroke
    const goldDist = dist(x, y, goldCx, goldCy);
    const inGoldRing = goldDist >= ringR - ringStroke && goldDist <= ringR;
    if (inGoldRing) return ACCENT_GOLD;
    
    // Check if inside gold center dot
    if (goldDist <= dotR) return ACCENT_GOLD;
    
    // Check if inside cyan ring's stroke
    const cyanDist = dist(x, y, cyanCx, cyanCy);
    const inCyanRing = cyanDist >= ringR - ringStroke && cyanDist <= ringR;
    if (inCyanRing) return ACCENT_CYAN;
    
    // Check if inside cyan center dot
    if (cyanDist <= dotR) return ACCENT_CYAN;
    
    // White info icon (vertical bar + dot)
    if (x >= infoX && x <= infoX + 14 * s && y >= infoYBase && y <= infoYBase + 48 * s) {
        return WHITE;
    }
    if (dist(x, y, infoX + 7 * s, infoYBase - 14 * s) <= 8 * s) {
        return WHITE;
    }
    
    return CLEAR;
}

function encodeIco(png, size) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // icon type
    header.writeUInt16LE(1, 4); // one image
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);  // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(22, 12); // offset
    return Buffer.concat([header, entry, png]);
}

mkdirSync(OUT, { recursive: true });
const png512 = encodePng(512, icon);
const png256 = encodePng(256, icon);
writeFileSync(resolve(OUT, 'icon.png'), png512);
writeFileSync(resolve(OUT, 'icon.ico'), encodeIco(png256, 256));
console.log(`wrote ${OUT}\\icon.png (${png512.length}b) and icon.ico (${png256.length}b)`);
