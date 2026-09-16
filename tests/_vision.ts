/**
 * Vision helpers for "what does the user actually see?" assertions.
 *
 * Why this exists: the previous generation of these tests asserted things like
 * `tile.style.transform === 'scaleX(-1) rotate(90deg)'` or grepped stylesheet
 * text for a rule name. Both are green even when the user sees an untransformed
 * tile, because:
 *   - an inline `style.transform` can be set while a UA-stylesheet `!important`
 *     rule (Chrome forces `transform: none` on the fullscreen element) wins the
 *     cascade, so the declaration is present but has zero visual effect;
 *   - a CSS rule can exist in a stylesheet and still not apply to the element.
 *
 * So we read *composited pixels* out of a real browser screenshot instead:
 * transforms, object-fit/letterboxing, overflow cropping and z-order are all
 * baked into those pixels exactly as the user perceives them.
 *
 * No image dependencies: PNG is decoded with node:zlib.
 */
import zlib from 'zlib';
import { Page } from '@playwright/test';

export type RGB = { r: number; g: number; b: number };
export type Quad = { tl: RGB; tr: RGB; bl: RGB; br: RGB };
export type ColorName = 'red' | 'green' | 'blue' | 'yellow' | 'other';
export type Rect = { x: number; y: number; width: number; height: number };

export type Frame = {
    width: number;
    height: number;
    channels: number;
    data: Buffer;
};

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Minimal PNG decoder (8-bit, non-interlaced, colour types 0/2/6). */
export function decodePng(buf: Buffer): Frame {
    let o = 8; // skip signature
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 6;
    let interlace = 0;
    const idat: Buffer[] = [];

    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o);
        const type = buf.toString('ascii', o + 4, o + 8);
        const data = buf.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        o += 12 + len;
    }

    if (bitDepth !== 8) throw new Error('decodePng: only 8-bit PNGs supported (got ' + bitDepth + ')');
    if (interlace !== 0) throw new Error('decodePng: interlaced PNG not supported');

    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
    if (!channels) throw new Error('decodePng: unsupported colour type ' + colorType);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(height * stride);
    let pos = 0;

    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        const line = raw.subarray(pos, pos + stride);
        pos += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= channels ? prev[x - channels] : 0;
            const v = line[x];
            let val: number;
            switch (filter) {
                case 0: val = v; break;
                case 1: val = v + a; break;
                case 2: val = v + b; break;
                case 3: val = v + ((a + b) >> 1); break;
                case 4: val = v + paeth(a, b, c); break;
                default: val = v; break;
            }
            cur[x] = val & 0xff;
        }
    }

    return { width, height, channels, data: out };
}

export function pixelAt(frame: Frame, x: number, y: number): RGB {
    const px = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
    const i = (py * frame.width + px) * frame.channels;
    return { r: frame.data[i], g: frame.data[i + 1], b: frame.data[i + 2] };
}

/**
 * Screenshot the viewport and decode it. Coordinates returned by
 * `getBoundingClientRect()` are viewport-relative, which is exactly the
 * coordinate space of a non-fullPage screenshot, so they can be used directly.
 */
export async function frameOfViewport(page: Page): Promise<Frame> {
    const buf = await page.screenshot({ fullPage: false });
    return decodePng(Buffer.from(buf));
}

/** Corners sampled at 25% / 75% inside a rect — inside each quadrant of a 2x2 pattern. */
export function quadrants(frame: Frame, rect: Rect): Quad {
    const at = (fx: number, fy: number) =>
        pixelAt(frame, rect.x + rect.width * fx, rect.y + rect.height * fy);
    return { tl: at(0.25, 0.25), tr: at(0.75, 0.25), bl: at(0.25, 0.75), br: at(0.75, 0.75) };
}

/** Sample an arbitrary point inside a rect using fractions of its size. */
export function samplePoint(frame: Frame, rect: Rect, fx: number, fy: number): RGB {
    return pixelAt(frame, rect.x + rect.width * fx, rect.y + rect.height * fy);
}

export function classify(c: RGB): ColorName {
    const high = 140;
    const low = 110;
    const isRed = c.r > high && c.g < low && c.b < low;
    const isGreen = c.g > high && c.r < low && c.b < low;
    const isBlue = c.b > high && c.r < low && c.g < low;
    const isYellow = c.r > high && c.g > high && c.b < low;
    if (isRed) return 'red';
    if (isGreen) return 'green';
    if (isBlue) return 'blue';
    if (isYellow) return 'yellow';
    return 'other';
}

export function quadNames(q: Quad): Record<keyof Quad, ColorName> {
    return { tl: classify(q.tl), tr: classify(q.tr), bl: classify(q.bl), br: classify(q.br) };
}

export function sameQuad(a: Record<string, ColorName>, b: Record<string, ColorName>): boolean {
    return a.tl === b.tl && a.tr === b.tr && a.bl === b.bl && a.br === b.br;
}

/** A mirrored 2x2 pattern: left/right columns swap, top/bottom rows keep their place. */
export function mirrored(q: Quad): Quad {
    return { tl: q.tr, tr: q.tl, bl: q.br, br: q.bl };
}

/** A 90° clockwise rotation of a 2x2 pattern. */
export function rotated90(q: Quad): Quad {
    return { tl: q.bl, tr: q.tl, br: q.tr, bl: q.br };
}

export function describe(q: Quad): string {
    const n = quadNames(q);
    return `${n.tl}/${n.tr}/${n.bl}/${n.br}`;
}

/** True when the tile shows the full 4-colour 2x2 pattern (i.e. nothing is cropped). */
export function isFullPattern(q: Quad): boolean {
    const names = quadNames(q);
    const set = new Set(Object.values(names));
    return set.size === 4 && !set.has('other');
}

function isSaturated(c: RGB): boolean {
    const max = Math.max(c.r, c.g, c.b);
    const min = Math.min(c.r, c.g, c.b);
    return max > 120 && max - min > 60;
}

/**
 * Find the on-screen bounding box of the actual video content inside `rect`.
 *
 * Tiles are letterboxed (`object-fit: contain`) and their width varies with the
 * layout, so sampling fixed fractions of the *element* lands in black bars. We
 * locate the saturated (coloured) region instead, which is what the user
 * actually perceives as the picture.
 */
export function contentBox(frame: Frame, rect: Rect): Rect | null {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(frame.width - 1, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(frame.height - 1, Math.ceil(rect.y + rect.height));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hits = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (isSaturated(pixelAt(frame, x, y))) {
                hits++;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (hits < 400 || maxX - minX < 24 || maxY - minY < 24) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Classify an n x n grid of samples spread across a box from 1/(2n) to 1-1/(2n).
 * Cell centres are used so no sample sits on a colour boundary.
 */
export function gridOf(frame: Frame, box: Rect, n = 4): ColorName[][] {
    const rows: ColorName[][] = [];
    for (let j = 0; j < n; j++) {
        const row: ColorName[] = [];
        for (let i = 0; i < n; i++) {
            const fx = (i + 0.5) / n;
            const fy = (j + 0.5) / n;
            row.push(classify(pixelAt(frame, box.x + box.width * fx, box.y + box.height * fy)));
        }
        rows.push(row);
    }
    return rows;
}

export function flipGridH(g: ColorName[][]): ColorName[][] {
    return g.map((row) => [...row].reverse());
}

export function flipGridV(g: ColorName[][]): ColorName[][] {
    return [...g].reverse().map((row) => [...row]);
}

/** Rotate the sampled grid 90 degrees clockwise. */
export function rotGridCW(g: ColorName[][]): ColorName[][] {
    const n = g.length;
    const out: ColorName[][] = [];
    for (let j = 0; j < n; j++) {
        const row: ColorName[] = [];
        for (let i = 0; i < n; i++) row.push(g[n - 1 - i][j]);
        out.push(row);
    }
    return out;
}

/** Rotate the sampled grid 90 degrees counter-clockwise. */
export function rotGridCCW(g: ColorName[][]): ColorName[][] {
    const n = g.length;
    const out: ColorName[][] = [];
    for (let j = 0; j < n; j++) {
        const row: ColorName[] = [];
        for (let i = 0; i < n; i++) row.push(g[i][n - 1 - j]);
        out.push(row);
    }
    return out;
}

/** Fraction of cells that agree (ignoring 'other', which is letterbox/overlay). */
export function matchRatio(a: ColorName[][], b: ColorName[][]): number {
    let total = 0;
    let same = 0;
    for (let j = 0; j < a.length; j++) {
        for (let i = 0; i < a[j].length; i++) {
            if (a[j][i] === 'other' || b[j][i] === 'other') continue;
            total++;
            if (a[j][i] === b[j][i]) same++;
        }
    }
    return total === 0 ? 0 : same / total;
}

/** Fraction of cells that differ, compared only where both grids have real colours. */
export function diffRatio(a: ColorName[][], b: ColorName[][]): number {
    return 1 - matchRatio(a, b);
}

export function gridToString(g: ColorName[][]): string {
    return g.map((r) => r.map((c) => c[0].toUpperCase()).join('')).join('|');
}
