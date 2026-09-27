// Minimal animated GIF writer (GIF89a, two solid frames, Netscape loop).
// Produces tests/fixtures/anim-2frame.gif, the animated-GIF icon fixture used
// by tests/icon-packs-crop-gif.spec.ts:
//   node tools/make-anim-gif.mjs
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';

// A deliberately simple, always-valid LZW stream: emit a clear code before
// every pixel. The decoder never builds dictionary entries (each code after a
// clear is a root code), so the code width stays at minCodeSize+1 bits and
// there is no dictionary-timing subtlety to get wrong. The file is bigger than
// a real encoder would produce, which is irrelevant for a test fixture.
function lzwEncode(minCodeSize, indices) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    const codeSize = minCodeSize + 1;
    const out = [];
    let cur = 0, bits = 0;

    function emit(code) {
        cur |= code << bits;
        bits += codeSize;
        while (bits >= 8) { out.push(cur & 0xff); cur >>= 8; bits -= 8; }
    }

    for (const px of indices) {
        emit(clearCode);
        emit(px);
    }
    emit(endCode);
    if (bits > 0) out.push(cur & 0xff);
    return out;
}

function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }

function makeGif(w, h, frames, delayCs) {
    const bytes = [];
    const push = (...arr) => bytes.push(...arr);

    push(...'GIF89a'.split('').map((c) => c.charCodeAt(0)));
    // Logical screen descriptor: global color table, 2 colours.
    push(...u16(w), ...u16(h), 0x80, 0x00, 0x00);
    // Global colour table: black, then a colour that changes per frame is not
    // possible with one table, so we use two fixed colours and swap which one
    // the whole frame is.
    push(0x00, 0x00, 0x00);   // index 0: black
    push(0xff, 0x3b, 0x30);   // index 1: red

    // Netscape looping extension.
    push(0x21, 0xff, 0x0b);
    push(...'NETSCAPE2.0'.split('').map((c) => c.charCodeAt(0)));
    push(0x03, 0x01, 0x00, 0x00, 0x00);

    for (const fill of frames) {
        // Graphic control extension: disposal 1, delay.
        push(0x21, 0xf9, 0x04, 0x04, ...u16(delayCs), 0x00, 0x00);
        // Image descriptor.
        push(0x2c, ...u16(0), ...u16(0), ...u16(w), ...u16(h), 0x00);
        const indices = new Array(w * h).fill(fill);
        const data = lzwEncode(2, indices);
        push(2); // LZW minimum code size
        for (let i = 0; i < data.length; i += 255) {
            const chunk = data.slice(i, i + 255);
            push(chunk.length, ...chunk);
        }
        push(0x00); // block terminator
    }
    push(0x3b); // trailer
    return Buffer.from(bytes);
}

const w = 40, h = 40;
// Frame 0: colour 0 (black). Frame 1: colour 1 (red). 30/100 s each.
const gif = makeGif(w, h, [0, 1], 30);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'anim-2frame.gif');
writeFileSync(out, gif);
console.log('wrote', gif.length, 'bytes to', out);
