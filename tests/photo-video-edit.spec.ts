import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `edit_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'TestPass123!');
    await page.fill('#register-confirm-password', 'TestPass123!');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });

    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', 'Test Server');
    await page.click('#confirm-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(1000);

    const serverIcon = page.locator('.server-icon').filter({ hasText: 'T' });
    await serverIcon.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.waitForSelector('.channel-item', { timeout: 5000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(500);
}

async function uploadTestImage(page: Page, filename = 'test-photo.png') {
    // 200x150 image: left half red (#ff0000), right half blue (#0000ff)
    const pngData = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 150;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 100, 150);
        ctx.fillStyle = '#0000ff';
        ctx.fillRect(100, 0, 100, 150);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    const buffer = Buffer.from(pngData, 'base64');
    await page.locator('#file-input').setInputFiles({ name: filename, mimeType: 'image/png', buffer });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
}

async function uploadTestText(page: Page) {
    await page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
}

// Generates a small webm in-page (colored animation, white dot moving) and uploads it.
async function uploadTestVideo(page: Page, seconds = 1.2, w = 160, h = 120) {
    const data = await page.evaluate(async ({ seconds, w, h }) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d')!;
        const stream = c.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        const done = new Promise<void>((res) => { rec.onstop = () => res(); });
        rec.start(100);
        const frames = Math.max(1, Math.round(seconds * 30));
        for (let i = 0; i < frames; i++) {
            // Every frame: left half red, right half blue (positional marker) + moving white dot.
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, w / 2, h);
            ctx.fillStyle = '#0000ff';
            ctx.fillRect(w / 2, 0, w / 2, h);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect((i * 3) % w, h / 2, 5, 5);
            await new Promise((r) => setTimeout(r, 33));
        }
        rec.stop();
        await done;
        const blob = new Blob(chunks, { type: 'video/webm' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 8192) {
            s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 8192)));
        }
        return { b64: btoa(s), size: blob.size };
    }, { seconds, w, h });
    await page.locator('#file-input').setInputFiles({ name: 'test-video.webm', mimeType: 'video/webm', buffer: Buffer.from(data.b64, 'base64') });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
}

async function openPhotoEdit(page: Page) {
    await page.click('#upload-btn-edit');
    await expect(page.locator('#photo-edit-modal')).toBeVisible({ timeout: 5000 });
    await page.waitForFunction(() => {
        const c = document.getElementById('photo-edit-canvas') as HTMLCanvasElement;
        return c && c.width > 0 && c.height > 0 && (c.width !== 300 || c.height !== 150);
    }, { timeout: 5000 });
}

async function openVideoEdit(page: Page) {
    await page.click('#upload-btn-edit');
    await expect(page.locator('#video-edit-modal')).toBeVisible({ timeout: 8000 });
    await page.waitForFunction(() => {
        const c = document.getElementById('video-edit-canvas') as HTMLCanvasElement;
        return c && c.width > 0 && c.height > 0;
    }, { timeout: 8000 });
}

async function canvasDims(page: Page, id = 'photo-edit-canvas') {
    return page.evaluate((canvasId) => {
        const c = document.getElementById(canvasId) as HTMLCanvasElement;
        return { w: c.width, h: c.height };
    }, id);
}

async function pixelAt(page: Page, canvasId: string, x: number, y: number) {
    return page.evaluate(({ canvasId, x, y }) => {
        const c = document.getElementById(canvasId) as HTMLCanvasElement;
        const d = c.getContext('2d')!.getImageData(x, y, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2] };
    }, { canvasId, x, y });
}

async function drawLine(page: Page, x1: number, y1: number, x2: number, y2: number) {
    const canvas = page.locator('#photo-edit-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not visible');
    await page.mouse.move(box.x + x1, box.y + y1);
    await page.mouse.down();
    await page.mouse.move(box.x + x2, box.y + y2, { steps: 8 });
    await page.mouse.up();
}

// selectedFiles / currentFileIndex are top-level `let` bindings, so they are
// NOT reachable via window.* — indirect eval reads them from the global scope.
async function getSelectedFile(page: Page): Promise<any> {
    return page.evaluate(() => (0, eval)('selectedFiles[currentFileIndex]'));
}

// Read the currently selected file as an image and return its natural dims.
async function currentImageInfo(page: Page) {
    return page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const url = URL.createObjectURL(f);
        return await new Promise<{ w: number; h: number; size: number; type: string }>((resolve) => {
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight, size: f.size, type: f.type }); };
            img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: -1, h: -1, size: f.size, type: f.type }); };
            img.src = url;
        });
    });
}

// Read the currently selected file as a video (dims / duration / size / type).
async function currentVideoInfo(page: Page) {
    return page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const url = URL.createObjectURL(f);
        return await new Promise<any>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.muted = true;
            v.onloadedmetadata = () => {
                URL.revokeObjectURL(url);
                resolve({ w: v.videoWidth, h: v.videoHeight, dur: v.duration, size: f.size, type: f.type, name: f.name });
            };
            v.onerror = () => { URL.revokeObjectURL(url); resolve({ w: -1, h: -1, dur: 0, size: f.size, type: f.type, name: f.name }); };
            v.src = url;
        });
    });
}

async function currentVideoDuration(page: Page) {
    return page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const url = URL.createObjectURL(f);
        return await new Promise<number>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.muted = true;
            v.onloadedmetadata = () => {
                // MediaRecorder webm often reports duration=Infinity; force the
                // browser to resolve the real end by seeking far.
                if (isFinite(v.duration) && v.duration > 0) { URL.revokeObjectURL(url); resolve(v.duration); return; }
                v.currentTime = 1e7;
                v.onseeked = () => {
                    URL.revokeObjectURL(url);
                    resolve(isFinite(v.duration) && v.duration > 0 ? v.duration : (v.currentTime || 0));
                };
            };
            v.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
            v.src = url;
        });
    });
}

// Client-side magic-byte validation: returns null when the declared type matches.
// Sample a pixel from the FIRST frame of the currently selected video file.
async function firstFramePixel(page: Page, x: number, y: number) {
    return page.evaluate(async ({ x, y }) => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const url = URL.createObjectURL(f);
        return await new Promise<any>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.muted = true;
            v.playsInline = true;
            v.onloadeddata = () => {
                const c = document.createElement('canvas');
                c.width = v.videoWidth;
                c.height = v.videoHeight;
                const ctx = c.getContext('2d')!;
                ctx.drawImage(v, 0, 0);
                const d = ctx.getImageData(x, y, 1, 1).data;
                URL.revokeObjectURL(url);
                resolve({ r: d[0], g: d[1], b: d[2], w: v.videoWidth, h: v.videoHeight });
            };
            v.onerror = () => { URL.revokeObjectURL(url); resolve({ r: -1, g: -1, b: -1, w: 0, h: 0 }); };
            v.src = url;
        });
    }, { x, y });
}

async function magicCheckCurrent(page: Page) {
    return page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        try { return await (window as any).checkUploadMagic(f); } catch (e) { return String(e); }
    });
}

async function cropBoxBounds(page: Page, prefix: 'photo' | 'video') {
    return page.evaluate((prefix) => {
        const box = document.getElementById(prefix + '-crop-box') as HTMLElement;
        const ov = document.getElementById(prefix + '-crop-overlay') as HTMLElement;
        const l = parseInt(box.style.left), t = parseInt(box.style.top);
        const w = parseInt(box.style.width), h = parseInt(box.style.height);
        return { l, t, w, h, ovW: ov.clientWidth, ovH: ov.clientHeight };
    }, prefix);
}

async function dragCutEndToPrefix(page: Page, prefix: 'video' | 'audio', fraction: number) {
    const track = await page.locator(`#${prefix}-cut-track`).boundingBox();
    const end = await page.locator(`#${prefix}-cut-end`).boundingBox();
    if (!track || !end) throw new Error('cut track not visible');
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2 - track.width * (1 - fraction), end.y + end.height / 2, { steps: 8 });
    await page.mouse.up();
}

async function dragCutStartToPrefix(page: Page, prefix: 'video' | 'audio', fraction: number) {
    const track = await page.locator(`#${prefix}-cut-track`).boundingBox();
    const start = await page.locator(`#${prefix}-cut-start`).boundingBox();
    if (!track || !start) throw new Error('cut track not visible');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + track.width * fraction, start.y + start.height / 2, { steps: 8 });
    await page.mouse.up();
}

async function dragCutEndTo(page: Page, fraction: number) {
    await dragCutEndToPrefix(page, 'video', fraction);
}

// ── Audio helpers ───────────────────────────────────────────────────────────

function wavBuffer(samples: Float32Array, rate = 44100): Buffer {
    const n = samples.length;
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), 44 + i * 2);
    }
    return buf;
}

function sineSamples(seconds: number, freq: number, amp: number, rate = 44100): Float32Array {
    const n = Math.round(seconds * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
    return out;
}

// 2s total: first half 440Hz, second half 880Hz (distinguishable by ZCR).
function twoToneSamples(secondsPer: number, rate = 44100): Float32Array {
    const a = sineSamples(secondsPer, 440, 0.6, rate);
    const b = sineSamples(secondsPer, 880, 0.6, rate);
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

// 1s total: 880Hz burst in the first 0.25s, then silence (reverse moves it to the tail).
function burstSamples(rate = 44100): Float32Array {
    const out = new Float32Array(rate);
    out.set(sineSamples(0.25, 880, 0.7, rate), 0);
    return out;
}

function parseWav(buf: Buffer) {
    const rate = buf.readUInt32LE(24);
    const chans = buf.readUInt16LE(22);
    const dataSize = buf.readUInt32LE(40);
    const n = dataSize / (chans * 2);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        samples[i] = buf.readInt16LE(44 + i * chans * 2) / 32768;
    }
    return { rate, chans, samples, duration: n / rate };
}

// Zero crossings per second in [from, to) seconds — distinguishes 440Hz (~880/s)
// from 880Hz (~1760/s) and silence (~0/s).
function zcr(samples: Float64Array, from: number, to: number, rate: number) {
    const i0 = Math.max(1, Math.floor(from * rate));
    const i1 = Math.min(samples.length, Math.floor(to * rate));
    let crossings = 0;
    for (let i = i0; i < i1; i++) {
        if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
    }
    return crossings / Math.max(0.001, (i1 - i0) / rate);
}

function rms(samples: Float64Array, from: number, to: number, rate: number) {
    const i0 = Math.max(0, Math.floor(from * rate));
    const i1 = Math.min(samples.length, Math.floor(to * rate));
    let sum = 0;
    let c = 0;
    for (let i = i0; i < i1; i++) { sum += samples[i] * samples[i]; c++; }
    return Math.sqrt(sum / Math.max(1, c));
}

function peak(samples: Float64Array) {
    let mx = 0;
    for (let i = 0; i < samples.length; i++) mx = Math.max(mx, Math.abs(samples[i]));
    return mx;
}

async function uploadTestAudio(page: Page, buffer: Buffer, filename = 'test-audio.wav') {
    await page.locator('#file-input').setInputFiles({ name: filename, mimeType: 'audio/wav', buffer });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
}

// Records a real opus webm in-page: 440Hz for the first half, 880Hz for the
// second (distinguishable by ZCR after decoding), so webm-format preservation
// can be verified with actual content.
async function uploadTestWebm(page: Page, seconds = 1.2) {
    const data = await page.evaluate(async ({ seconds }) => {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        const rate = 44100;
        const n = Math.round(seconds * rate);
        const buf = ctx.createBuffer(1, n, rate);
        const ch = buf.getChannelData(0);
        const half = Math.floor(n / 2);
        for (let i = 0; i < n; i++) {
            const f = i < half ? 440 : 880;
            ch[i] = 0.6 * Math.sin(2 * Math.PI * f * i / rate);
        }
        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        const done = new Promise<void>((res) => { rec.onstop = () => res(); });
        rec.start(100);
        src.start();
        await new Promise((r) => setTimeout(r, seconds * 1000 + 300));
        rec.stop();
        await done;
        await ctx.close();
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const b = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
        return { b64: btoa(s), size: blob.size };
    }, { seconds });
    expect(data.size).toBeGreaterThan(500);
    await page.locator('#file-input').setInputFiles({ name: 'test-audio.webm', mimeType: 'audio/webm', buffer: Buffer.from(data.b64, 'base64') });
    await page.waitForSelector('#upload-modal', { state: 'visible', timeout: 5000 });
}

// Decodes the currently selected file and reports duration + ZCR of channel 0.
async function decodeAudioStats(page: Page) {
    return page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const ctx = new AudioContext();
        const ab = await f.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        const ch = buf.getChannelData(0);
        let crossings = 0;
        for (let i = 1; i < ch.length; i++) {
            if ((ch[i - 1] < 0 && ch[i] >= 0) || (ch[i - 1] >= 0 && ch[i] < 0)) crossings++;
        }
        const dur = buf.duration || 0.001;
        await ctx.close();
        return { duration: buf.duration, zcr: crossings / dur, rate: buf.sampleRate };
    });
}

async function openAudioEdit(page: Page) {
    await page.click('#upload-btn-edit');
    await expect(page.locator('#audio-edit-modal')).toBeVisible({ timeout: 8000 });
    await page.waitForFunction(() => {
        const s = (window as any).audioEditState;
        return s && s.buffer && s.buffer.length > 0;
    }, { timeout: 8000 });
}

async function currentAudioBytes(page: Page): Promise<Buffer> {
    const b64 = await page.evaluate(async () => {
        const f = (0, eval)('selectedFiles[currentFileIndex]');
        const buf = new Uint8Array(await f.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 8192) {
            s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 8192)));
        }
        return btoa(s);
    });
    return Buffer.from(b64, 'base64');
}

async function confirmUploadAndWait(page: Page) {
    await page.click('#confirm-upload');
    await expect(page.locator('#upload-modal')).not.toBeVisible({ timeout: 30000 });
    await expect(page.locator('#upload-error')).not.toBeVisible({ timeout: 2000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Photo & Video Edit System', () => {

    test.describe('Upload Modal Quick Actions', () => {

        test('quick action buttons appear for image files', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await expect(page.locator('#upload-quick-actions')).toBeVisible();
        });

        test('quick action buttons appear for video files', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await expect(page.locator('#upload-quick-actions')).toBeVisible();
        });

        test('quick action buttons hidden for non-media files', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestText(page);
            await expect(page.locator('#upload-quick-actions')).toBeHidden();
        });

        test('edit button opens photo edit modal for images', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-edit-canvas')).toBeAttached();
        });

        test('edit button opens video edit modal for videos', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await expect(page.locator('#video-edit-canvas')).toBeAttached();
        });

        test('rotate right button applies CSS transform to preview', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await page.click('#upload-btn-rotate-right');
            const transform = await page.locator('#upload-preview img').evaluate((el: HTMLElement) => el.style.transform);
            expect(transform).toContain('rotate');
        });

        test('mirror button applies scaleX to preview', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await page.click('#upload-btn-mirror');
            const transform = await page.locator('#upload-preview img').evaluate((el: HTMLElement) => el.style.transform);
            expect(transform).toContain('scaleX');
        });

        test('rotating twice returns the preview transform to neutral', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await page.click('#upload-btn-rotate-right');
            await page.click('#upload-btn-rotate-right');
            const transform = await page.locator('#upload-preview img').evaluate((el: HTMLElement) => el.style.transform);
            expect(transform).toContain('rotate(180deg)');
        });

        test('quick-action rotate transforms the actual image file (not cosmetic)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await page.click('#upload-btn-rotate-right');
            const out = await page.evaluate(async () => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                const idx = (0, eval)('currentFileIndex');
                const outFile = await (window as any)._applyUploadTransformsToFile(f, idx);
                const url = URL.createObjectURL(outFile);
                return await new Promise<any>((resolve) => {
                    const img = new Image();
                    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
                    img.onerror = () => resolve({ w: -1, h: -1 });
                    img.src = url;
                });
            });
            // 200x150 rotated 90° -> 150x200
            expect(out.w).toBe(150);
            expect(out.h).toBe(200);
        });

        test('uploading a quick-rotated image succeeds end-to-end', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await page.click('#upload-btn-rotate-right');
            await page.click('#upload-btn-mirror');
            await confirmUploadAndWait(page);
        });
    });

    test.describe('Photo Edit Modal - Basic', () => {

        test('photo edit modal opens with canvas', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-edit-canvas')).toBeAttached();
        });

        test('photo edit modal has all tool buttons', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-tool-brush')).toBeVisible();
            await expect(page.locator('#photo-tool-airbrush')).toBeVisible();
            await expect(page.locator('#photo-tool-crop')).toBeVisible();
            await expect(page.locator('#photo-btn-mirror')).toBeVisible();
            await expect(page.locator('#photo-btn-rotate-left')).toBeVisible();
            await expect(page.locator('#photo-btn-rotate-right')).toBeVisible();
        });

        test('photo edit modal has undo/redo buttons', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-undo')).toBeAttached();
            await expect(page.locator('#photo-redo')).toBeAttached();
        });

        test('photo edit cancel closes modal', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-edit-modal')).toBeVisible();
            await page.click('#photo-edit-cancel');
            await expect(page.locator('#photo-edit-modal')).toBeHidden();
        });

        test('brush tool is active by default', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-tool-brush')).toHaveClass(/active/);
        });
    });

    test.describe('Photo Edit - Drawing', () => {

        test('placing a simple dot shows the confirm/discard buttons', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const canvas = page.locator('#photo-edit-canvas');
            const box = await canvas.boundingBox();
            if (!box) throw new Error('Canvas not visible');
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.up();
            await expect(page.locator('#photo-draw-actions')).toBeVisible({ timeout: 2000 });
        });

        test('confirm drawing saves the state', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 150, 20, 150, 80); // over the blue half
            await expect(page.locator('#photo-draw-actions')).toBeVisible();
            await page.click('#photo-draw-confirm');
            await expect(page.locator('#photo-draw-actions')).toBeHidden();
            const px = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(px.g).toBeGreaterThan(100);
            expect(px.b).toBeLessThan(100);
        });

        test('airbrush drawing works and can be confirmed', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-airbrush');
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 150, 20, 150, 80); // over the blue half
            await expect(page.locator('#photo-draw-actions')).toBeVisible();
            await page.click('#photo-draw-confirm');
            const px = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(px.g).toBeGreaterThan(100);
        });

        test('discard drawing reverts to pre-draw state', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const pixelsBefore = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 140, 40, 160, 60);
            await expect(page.locator('#photo-draw-actions')).toBeVisible();
            await page.click('#photo-draw-cancel');
            await expect(page.locator('#photo-draw-actions')).toBeHidden();
            const pixelsAfter = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(pixelsAfter).toEqual(pixelsBefore);
        });

        test('discard removes only the current unconfirmed stroke, not previous edits', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.fill('#photo-brush-color', '#00ff00');
            // Stroke 1: confirm it.
            await drawLine(page, 10, 10, 30, 30);
            await page.click('#photo-draw-confirm');
            // Stroke 2: leave unconfirmed, then discard.
            await drawLine(page, 150, 50, 150, 90);
            await page.click('#photo-draw-cancel');
            // Stroke 1 remains (green over the red half).
            const s1 = await pixelAt(page, 'photo-edit-canvas', 20, 20);
            expect(s1.g).toBeGreaterThan(150);
            expect(s1.r).toBeLessThan(100);
            // Stroke 2 is gone (back to blue over the blue half).
            const s2 = await pixelAt(page, 'photo-edit-canvas', 150, 70);
            expect(s2.b).toBeGreaterThan(150);
        });

        test('switching from draw to crop voids the unconfirmed drawing', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const before = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 140, 40, 160, 60);
            await expect(page.locator('#photo-draw-actions')).toBeVisible();
            await page.click('#photo-tool-crop');
            await expect(page.locator('#photo-draw-actions')).toBeHidden();
            const after = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(after).toEqual(before);
        });

        test('undo/redo works for committed drawings', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const before = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 140, 40, 160, 60);
            await page.click('#photo-draw-confirm');
            const afterDraw = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(afterDraw.g).toBeGreaterThan(100);
            await page.click('#photo-undo');
            const afterUndo = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(afterUndo).toEqual(before);
            await page.click('#photo-redo');
            const afterRedo = await pixelAt(page, 'photo-edit-canvas', 150, 50);
            expect(afterRedo.g).toBeGreaterThan(100);
        });
    });

    test.describe('Photo Edit - Mirror & Rotate', () => {

        test('undo button is disabled initially', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await expect(page.locator('#photo-undo')).toBeDisabled();
        });

        test('undo becomes enabled after a transform', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-mirror');
            await expect(page.locator('#photo-undo')).toBeEnabled();
        });

        test('undo restores previous state after transform', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const dimsBefore = await canvasDims(page);
            await page.click('#photo-btn-rotate-right');
            const dimsAfterRotate = await canvasDims(page);
            expect(dimsAfterRotate.w).toBe(dimsBefore.h);
            expect(dimsAfterRotate.h).toBe(dimsBefore.w);
            await page.click('#photo-undo');
            const dimsAfterUndo = await canvasDims(page);
            expect(dimsAfterUndo.w).toBe(dimsBefore.w);
            expect(dimsAfterUndo.h).toBe(dimsBefore.h);
        });

        test('redo re-applies undone transform', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const dimsBefore = await canvasDims(page);
            await page.click('#photo-btn-rotate-right');
            await page.click('#photo-undo');
            await page.click('#photo-redo');
            const dimsAfterRedo = await canvasDims(page);
            expect(dimsAfterRedo.w).toBe(dimsBefore.h);
            expect(dimsAfterRedo.h).toBe(dimsBefore.w);
        });

        test('mirror is baked into the canvas (not cosmetic)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            // Original: left half red, right half blue.
            const before = await pixelAt(page, 'photo-edit-canvas', 150, 75);
            expect(before.b).toBeGreaterThan(150);
            expect(before.r).toBeLessThan(100);
            await page.click('#photo-btn-mirror');
            // After horizontal flip: the red half moved to the right.
            const after = await pixelAt(page, 'photo-edit-canvas', 150, 75);
            expect(after.r).toBeGreaterThan(150);
            expect(after.b).toBeLessThan(100);
            const left = await pixelAt(page, 'photo-edit-canvas', 50, 75);
            expect(left.b).toBeGreaterThan(150);
        });

        test('rotate is baked into the canvas (not cosmetic)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            // 90° CW: the original top row (red left / blue right) maps to the right column.
            const pxTopRed = await pixelAt(page, 'photo-edit-canvas', 149, 50);
            expect(pxTopRed.r).toBeGreaterThan(150);
            expect(pxTopRed.b).toBeLessThan(100);
            const pxTopBlue = await pixelAt(page, 'photo-edit-canvas', 149, 150);
            expect(pxTopBlue.b).toBeGreaterThan(150);
        });

        test('mirror preserves drawn content', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 10, 10, 30, 30);
            await page.click('#photo-draw-confirm');
            await page.click('#photo-btn-mirror');
            // Green line (drawn at x 10..30) moved to x 170..190 after the flip.
            const px = await pixelAt(page, 'photo-edit-canvas', 180, 20);
            expect(px.g).toBeGreaterThan(150);
        });

        test('rotate preserves previous transforms', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const dimsOrig = await canvasDims(page);
            await page.click('#photo-btn-mirror');
            await page.click('#photo-btn-rotate-right');
            const dimsAfter = await canvasDims(page);
            expect(dimsAfter.w).toBe(dimsOrig.h);
            expect(dimsAfter.h).toBe(dimsOrig.w);
            await page.click('#photo-undo');
            const dimsUndo = await canvasDims(page);
            expect(dimsUndo.w).toBe(dimsOrig.w);
            expect(dimsUndo.h).toBe(dimsOrig.h);
        });

        test('undo twice then redo twice restores the full chain', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const orig = await canvasDims(page);
            await page.click('#photo-btn-mirror');
            await page.click('#photo-btn-rotate-right');
            const swapped = await canvasDims(page);
            expect(swapped.w).toBe(orig.h);
            await page.click('#photo-undo');
            await page.click('#photo-undo');
            expect(await canvasDims(page)).toEqual(orig);
            await page.click('#photo-redo');
            await page.click('#photo-redo');
            expect(await canvasDims(page)).toEqual(swapped);
        });
    });

    test.describe('Photo Edit - Crop', () => {

        test('crop tool shows overlay and settings', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-crop');
            await expect(page.locator('#photo-crop-overlay')).toBeVisible();
            await expect(page.locator('#photo-crop-settings')).toBeVisible();
        });

        test('crop box is inside canvas bounds', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-crop');
            const bounds = await cropBoxBounds(page, 'photo');
            expect(bounds.l).toBeGreaterThanOrEqual(0);
            expect(bounds.t).toBeGreaterThanOrEqual(0);
            expect(bounds.l + bounds.w).toBeLessThanOrEqual(bounds.ovW);
            expect(bounds.t + bounds.h).toBeLessThanOrEqual(bounds.ovH);
        });

        test('apply crop changes canvas dimensions', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const dimsBefore = await canvasDims(page);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', String(Math.round(dimsBefore.w / 2)));
            await page.fill('#photo-crop-h', String(Math.round(dimsBefore.h / 2)));
            await page.click('#photo-crop-confirm');
            const dimsAfter = await canvasDims(page);
            expect(dimsAfter.w).toBeLessThan(dimsBefore.w);
            expect(dimsAfter.h).toBeLessThan(dimsBefore.h);
        });

        test('crop width input larger than the canvas is clamped inside', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '99999');
            await page.fill('#photo-crop-h', '99999');
            const bounds = await cropBoxBounds(page, 'photo');
            expect(bounds.l).toBeGreaterThanOrEqual(0);
            expect(bounds.t).toBeGreaterThanOrEqual(0);
            expect(bounds.l + bounds.w).toBeLessThanOrEqual(bounds.ovW);
            expect(bounds.t + bounds.h).toBeLessThanOrEqual(bounds.ovH);
        });

        test('crop after rotation stays inside the canvas', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            const rotated = await canvasDims(page);
            expect(rotated.w).toBe(150);
            expect(rotated.h).toBe(200);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '99999');
            await page.fill('#photo-crop-h', '99999');
            const bounds = await cropBoxBounds(page, 'photo');
            expect(bounds.l).toBeGreaterThanOrEqual(0);
            expect(bounds.t).toBeGreaterThanOrEqual(0);
            expect(bounds.l + bounds.w).toBeLessThanOrEqual(bounds.ovW);
            expect(bounds.t + bounds.h).toBeLessThanOrEqual(bounds.ovH);
            await page.click('#photo-crop-confirm');
            const cropped = await canvasDims(page);
            expect(cropped.w).toBeLessThanOrEqual(rotated.w);
            expect(cropped.h).toBeLessThanOrEqual(rotated.h);
        });

        test('crop then rotate keeps the crop region', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '100');
            await page.fill('#photo-crop-h', '75');
            await page.click('#photo-crop-confirm');
            const cropped = await canvasDims(page);
            expect(cropped.w).toBe(100);
            expect(cropped.h).toBe(75);
            await page.click('#photo-btn-rotate-right');
            const afterRotate = await canvasDims(page);
            expect(afterRotate.w).toBe(75);
            expect(afterRotate.h).toBe(100);
        });

        test('crop then undo restores the full canvas', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            const orig = await canvasDims(page);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '80');
            await page.fill('#photo-crop-h', '60');
            await page.click('#photo-crop-confirm');
            expect(await canvasDims(page)).not.toEqual(orig);
            await page.click('#photo-undo');
            expect(await canvasDims(page)).toEqual(orig);
            await page.click('#photo-redo');
            const re = await canvasDims(page);
            expect(re.w).toBeLessThan(orig.w);
            expect(re.h).toBeLessThan(orig.h);
        });
    });

    test.describe('Photo Edit - Confirm replaces file', () => {

        test('confirm edit applies transform and closes modal', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            await page.click('#photo-edit-confirm');
            await expect(page.locator('#photo-edit-modal')).toBeHidden({ timeout: 3000 });
            await expect(page.locator('#upload-modal')).toBeVisible();
        });

        test('confirmed rotation replaces the file with swapped dimensions', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            await page.click('#photo-edit-confirm');
            await expect(page.locator('#photo-edit-modal')).toBeHidden({ timeout: 5000 });
            const info = await currentImageInfo(page);
            expect(info.w).toBe(150);
            expect(info.h).toBe(200);
            expect(info.type).toBe('image/png');
        });

        test('confirmed crop produces a cropped file', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '100');
            await page.fill('#photo-crop-h', '75');
            await page.click('#photo-crop-confirm');
            await page.click('#photo-edit-confirm');
            await expect(page.locator('#photo-edit-modal')).toBeHidden({ timeout: 5000 });
            const info = await currentImageInfo(page);
            expect(info.w).toBe(100);
            expect(info.h).toBe(75);
        });

        test('edited image passes client-side magic-byte validation', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            await page.click('#photo-btn-mirror');
            await page.click('#photo-edit-confirm');
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('full permutation: draw, rotate, crop, mirror with undo/redo, then confirm', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            // 1. Draw + confirm
            await page.fill('#photo-brush-color', '#00ff00');
            await drawLine(page, 10, 10, 30, 30);
            await page.click('#photo-draw-confirm');
            // 2. Rotate right -> 150x200
            await page.click('#photo-btn-rotate-right');
            expect(await canvasDims(page)).toEqual({ w: 150, h: 200 });
            // 3. Crop to half (75x100)
            await page.click('#photo-tool-crop');
            await page.fill('#photo-crop-w', '75');
            await page.fill('#photo-crop-h', '100');
            await page.click('#photo-crop-confirm');
            expect(await canvasDims(page)).toEqual({ w: 75, h: 100 });
            // 4. Mirror (dims unchanged)
            await page.click('#photo-btn-mirror');
            expect(await canvasDims(page)).toEqual({ w: 75, h: 100 });
            // 5. Undo the mirror -> crop still applied
            await page.click('#photo-undo');
            expect(await canvasDims(page)).toEqual({ w: 75, h: 100 });
            // 6. Undo the crop -> rotation still applied
            await page.click('#photo-undo');
            expect(await canvasDims(page)).toEqual({ w: 150, h: 200 });
            // 7. Redo the crop -> 75x100 again
            await page.click('#photo-redo');
            expect(await canvasDims(page)).toEqual({ w: 75, h: 100 });
            // 8. Confirm -> file replaced with the final state
            await page.click('#photo-edit-confirm');
            await expect(page.locator('#photo-edit-modal')).toBeHidden({ timeout: 5000 });
            const info = await currentImageInfo(page);
            expect(info.w).toBe(75);
            expect(info.h).toBe(100);
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('uploading the edited image succeeds end-to-end', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestImage(page);
            await openPhotoEdit(page);
            await page.click('#photo-btn-rotate-right');
            await page.click('#photo-edit-confirm');
            await confirmUploadAndWait(page);
        });
    });

    test.describe('Video Edit Modal', () => {

        test('modal opens with canvas at video dimensions', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            const dims = await canvasDims(page, 'video-edit-canvas');
            expect(dims.w).toBe(160);
            expect(dims.h).toBe(120);
        });

        test('modal opens without forcing the crop overlay', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await expect(page.locator('#video-crop-overlay')).toBeHidden();
            await expect(page.locator('#video-cut-timeline')).toBeHidden();
        });

        test('rotate right swaps the canvas dimensions', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            const dims = await canvasDims(page, 'video-edit-canvas');
            expect(dims.w).toBe(120);
            expect(dims.h).toBe(160);
        });

        test('rotate left swaps the canvas dimensions too', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-left');
            const dims = await canvasDims(page, 'video-edit-canvas');
            expect(dims.w).toBe(120);
            expect(dims.h).toBe(160);
        });

        test('mirror keeps dimensions and renders frame content', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-mirror');
            const dims = await canvasDims(page, 'video-edit-canvas');
            expect(dims.w).toBe(160);
            expect(dims.h).toBe(120);
            const content = await page.evaluate(() => {
                const c = document.getElementById('video-edit-canvas') as HTMLCanvasElement;
                const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
                let nonZero = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) nonZero++;
                }
                return nonZero;
            });
            expect(content).toBeGreaterThan(0);
        });

        test('crop stays inside the canvas and shrinks it after apply', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '99999');
            await page.fill('#video-crop-h', '99999');
            const bounds = await cropBoxBounds(page, 'video');
            expect(bounds.l).toBeGreaterThanOrEqual(0);
            expect(bounds.t).toBeGreaterThanOrEqual(0);
            expect(bounds.l + bounds.w).toBeLessThanOrEqual(bounds.ovW);
            expect(bounds.t + bounds.h).toBeLessThanOrEqual(bounds.ovH);
        });

        test('applying a crop does not re-arm a second crop box', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            // After applying, crop mode exits: no overlay, no new box to dismiss.
            await expect(page.locator('#video-crop-overlay')).toBeHidden();
            const tool = await page.evaluate(() => (window as any).videoEditState.tool);
            expect(tool).toBeNull();
            const dims = await canvasDims(page, 'video-edit-canvas');
            expect(dims.w).toBe(80);
            expect(dims.h).toBe(60);
        });

        test('live crop preview appears with the crop tool and hides when crop mode exits', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await expect(page.locator('#video-crop-preview')).toBeHidden();
            await page.click('#video-tool-crop');
            await expect(page.locator('#video-crop-preview')).toBeVisible();
            // Non-blank: the preview canvas actually drew the boxed region.
            const drawn = await page.evaluate(() => {
                const c = document.getElementById('video-crop-preview-canvas') as HTMLCanvasElement;
                const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
                let nonZero = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) nonZero++;
                }
                return nonZero;
            });
            expect(drawn).toBeGreaterThan(0);
            await page.click('#video-crop-confirm');
            await expect(page.locator('#video-crop-preview')).toBeHidden();
        });

        test('live crop preview shows the exact boxed region and follows the box', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            // Box over the RIGHT (blue) half of the 160x120 video (scale 1).
            await page.evaluate(() => {
                (window as any)._videoSetCropBox(80, 0, 80, 120);
            });
            const blue = await page.evaluate(() => {
                const c = document.getElementById('video-crop-preview-canvas') as HTMLCanvasElement;
                const d = c.getContext('2d')!.getImageData(40, 60, 1, 1).data;
                return { r: d[0], g: d[1], b: d[2] };
            });
            expect(blue.b).toBeGreaterThan(150);
            expect(blue.r).toBeLessThan(100);
            // Move the box over the LEFT (red) half — the preview must follow live.
            await page.evaluate(() => {
                (window as any)._videoSetCropBox(0, 0, 80, 120);
            });
            const red = await page.evaluate(() => {
                const c = document.getElementById('video-crop-preview-canvas') as HTMLCanvasElement;
                const d = c.getContext('2d')!.getImageData(40, 60, 1, 1).data;
                return { r: d[0], g: d[1], b: d[2] };
            });
            expect(red.r).toBeGreaterThan(150);
            expect(red.b).toBeLessThan(100);
        });

        test('crop after rotation stays inside and shrinks the canvas', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            const rotated = await canvasDims(page, 'video-edit-canvas');
            expect(rotated.w).toBe(120);
            expect(rotated.h).toBe(160);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '60');
            await page.fill('#video-crop-h', '80');
            await page.click('#video-crop-confirm');
            const cropped = await canvasDims(page, 'video-edit-canvas');
            expect(cropped.w).toBeLessThanOrEqual(rotated.w);
            expect(cropped.h).toBeLessThanOrEqual(rotated.h);
            expect(cropped.w).toBe(60);
            expect(cropped.h).toBe(80);
        });

        test('cut drag updates the cut range', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            await expect(page.locator('#video-cut-timeline')).toBeVisible();
            await dragCutEndTo(page, 0.75);
            const cutEnd = await page.evaluate(() => (window as any).videoEditState.cutEnd);
            expect(cutEnd).toBeGreaterThan(0.6);
            expect(cutEnd).toBeLessThan(0.9);
        });

        test('cut timeline shows a seconds ruler with tick labels', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page, 3.2);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            await expect(page.locator('#video-cut-timeline')).toBeVisible();
            const ticks = await page.evaluate(() => {
                const ruler = document.getElementById('video-cut-ruler')!;
                const labels = Array.from(ruler.querySelectorAll('.video-cut-tick-label')).map((el) => el.textContent);
                return { count: ruler.children.length, labels, total: (document.getElementById('video-cut-total') as HTMLElement).textContent };
            });
            expect(ticks.count).toBeGreaterThanOrEqual(3);
            expect(ticks.labels[0]).toBe('0:00');
            expect(ticks.total).toMatch(/^of 0:0\d$/);
        });

        test('cut track shows a frame strip with real content from the video', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            await expect(page.locator('#video-cut-timeline')).toBeVisible();
            // The strip fills in progressively as frames are sampled; wait until
            // the left edge samples red and the right edge blue (the test video
            // is red left / blue right), sampled away from the moving white dot.
            await page.waitForFunction(() => {
                const cv = document.getElementById('video-cut-strip') as HTMLCanvasElement | null;
                if (!cv || !cv.width || !cv.height) return false;
                const g = cv.getContext('2d')!;
                const W = cv.width, H = cv.height;
                if (W < 200 || H < 30) return false;
                let nonBlack = 0;
                for (let x = 8; x < W; x += Math.max(8, Math.floor(W / 12))) {
                    const d = g.getImageData(x, Math.floor(H * 0.3), 1, 1).data;
                    if (d[0] > 100 || d[1] > 100 || d[2] > 100) nonBlack++;
                }
                if (nonBlack < 4) return false;
                const l = g.getImageData(Math.floor(W * 0.15), Math.floor(H * 0.3), 1, 1).data;
                const r = g.getImageData(Math.floor(W * 0.85), Math.floor(H * 0.3), 1, 1).data;
                return l[0] > 120 && l[2] < 80 && r[2] > 120 && r[0] < 80;
            }, { timeout: 10000 });
            // The strip must survive trimming (dragging handles) unchanged.
            const before = await page.evaluate(() => {
                const cv = document.getElementById('video-cut-strip') as HTMLCanvasElement;
                return { w: cv.width, h: cv.height, built: (window as any).videoEditState._stripBuilt };
            });
            expect(before.built).toBe(true);
            await dragCutEndTo(page, 0.6);
            const after = await page.evaluate(() => {
                const cv = document.getElementById('video-cut-strip') as HTMLCanvasElement;
                const g = cv.getContext('2d')!;
                const d = g.getImageData(Math.floor(cv.width * 0.15), Math.floor(cv.height * 0.3), 1, 1).data;
                return { w: cv.width, h: cv.height, r: d[0], b: d[2] };
            });
            expect(after.w).toBe(before.w);
            expect(after.r).toBeGreaterThan(120);
            expect(after.b).toBeLessThan(80);
        });

        test('cut preview plays inside the cut range (loops) and stops', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            await dragCutEndTo(page, 0.5);
            const cutEnd = await page.evaluate(() => (window as any).videoEditState.cutEnd);
            expect(cutEnd).toBeLessThan(0.6);
            await page.click('#video-cut-play');
            await expect(page.locator('#video-cut-play')).toHaveText('⏸ Stop Preview');
            // Wait past the cut length: without looping, playback would exceed the
            // cut end (0.6s). Staying inside proves the loop + the range clamp.
            await page.waitForTimeout(900);
            const during = await page.evaluate(() => {
                const v = document.getElementById('video-edit-source') as HTMLVideoElement;
                const s = (window as any).videoEditState;
                const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
                return { t: v.currentTime, playing: (window as any)._videoPreviewPlaying, paused: v.paused, endT: s.cutEnd * dur };
            });
            expect(during.playing).toBe(true);
            expect(during.paused).toBe(false);
            expect(during.t).toBeGreaterThanOrEqual(0);
            expect(during.t).toBeLessThan(during.endT + 0.1);
            await page.click('#video-cut-play');
            await expect(page.locator('#video-cut-play')).toHaveText('▶ Preview');
            const stopped = await page.evaluate(() => ({
                playing: (window as any)._videoPreviewPlaying,
                paused: (document.getElementById('video-edit-source') as HTMLVideoElement).paused,
                playhead: (document.getElementById('video-cut-playhead') as HTMLElement).style.display,
            }));
            expect(stopped.playing).toBe(false);
            expect(stopped.paused).toBe(true);
            expect(stopped.playhead).toBe('none');
        });

        test('undo/redo works after a transform', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            const orig = await canvasDims(page, 'video-edit-canvas');
            await page.click('#video-btn-rotate-right');
            const rotated = await canvasDims(page, 'video-edit-canvas');
            expect(rotated.w).toBe(orig.h);
            await page.click('#video-undo');
            expect(await canvasDims(page, 'video-edit-canvas')).toEqual(orig);
            await page.click('#video-redo');
            expect(await canvasDims(page, 'video-edit-canvas')).toEqual(rotated);
        });

        test('cancel leaves the original file untouched', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            const before = await currentVideoInfo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-btn-mirror');
            await page.click('#video-edit-cancel');
            await expect(page.locator('#video-edit-modal')).toBeHidden();
            const after = await currentVideoInfo(page);
            expect(after.size).toBe(before.size);
            expect(after.type).toBe('video/webm');
            expect(after.name).toBe('test-video.webm');
        });
    });

    test.describe('Video Edit - Confirm export', () => {

        test('confirm with rotation produces a non-empty webm with swapped dimensions', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            const info = await currentVideoInfo(page);
            expect(info.type).toBe('video/webm');
            expect(info.name).toBe('test-video.webm');
            expect(info.size).toBeGreaterThan(0);
            expect(info.w).toBe(120);
            expect(info.h).toBe(160);
        });

        test('confirm with crop produces a cropped webm', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            const info = await currentVideoInfo(page);
            expect(info.size).toBeGreaterThan(0);
            expect(info.w).toBe(80);
            expect(info.h).toBe(60);
        });

        test('crop lands at the exact position in the uploaded video (not just size)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            // Position the crop box over the RIGHT half of the 160x120 video (scale 1).
            await page.evaluate(() => {
                const box = document.getElementById('video-crop-box') as HTMLElement;
                box.style.left = '80px';
                box.style.top = '0px';
                box.style.width = '80px';
                box.style.height = '120px';
            });
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            const px = await firstFramePixel(page, 40, 60);
            expect(px.w).toBe(80);
            expect(px.h).toBe(120);
            // The right half of every source frame is blue.
            expect(px.b).toBeGreaterThan(150);
            expect(px.r).toBeLessThan(100);
        });

        test('confirm with a cut shortens the video duration', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page, 1.2);
            const srcDur = await currentVideoDuration(page);
            expect(srcDur).toBeGreaterThan(0.5);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            await dragCutEndTo(page, 0.75);
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            const outDur = await currentVideoDuration(page);
            expect(outDur).toBeGreaterThan(0);
            expect(outDur).toBeLessThan(srcDur * 0.9 + 0.1);
        });

        test('exported video passes client-side magic-byte validation', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-btn-mirror');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('full permutation: rotate, mirror, crop, undo/redo, confirm produces valid webm', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            // Rotate right -> 120x160
            await page.click('#video-btn-rotate-right');
            // Mirror (dims unchanged)
            await page.click('#video-btn-mirror');
            // Crop to 60x80
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '60');
            await page.fill('#video-crop-h', '80');
            await page.click('#video-crop-confirm');
            expect(await canvasDims(page, 'video-edit-canvas')).toEqual({ w: 60, h: 80 });
            // Undo crop -> 120x160, redo -> 60x80
            await page.click('#video-undo');
            expect(await canvasDims(page, 'video-edit-canvas')).toEqual({ w: 120, h: 160 });
            await page.click('#video-redo');
            expect(await canvasDims(page, 'video-edit-canvas')).toEqual({ w: 60, h: 80 });
            // Confirm -> exported webm matches
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            const info = await currentVideoInfo(page);
            expect(info.size).toBeGreaterThan(0);
            expect(info.type).toBe('video/webm');
            expect(info.w).toBe(60);
            expect(info.h).toBe(80);
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('uploading the edited video succeeds end-to-end', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 15000 });
            await confirmUploadAndWait(page);
        });
    });

    test.describe('Video Edit - Export plays correctly', () => {

        // Sample a pixel of the current selected file at several times across its
        // duration. Proves the export is a real, playable video with visible
        // content from start to end (never a black or empty file).
        async function sampleVideoFrames(page: Page, x: number, y: number, fractions: number[] = [0.05, 0.35, 0.65, 0.95]) {
            return page.evaluate(async ({ x, y, fractions }) => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                const url = URL.createObjectURL(f);
                const v = document.createElement('video');
                v.preload = 'auto'; v.muted = true; v.playsInline = true;
                await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('load failed')); v.src = url; });
                if (!isFinite(v.duration) || v.duration <= 0) {
                    v.currentTime = 1e7;
                    await new Promise<void>((res) => { v.onseeked = () => res(); });
                }
                const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime;
                const samples: any[] = [];
                for (const frac of fractions) {
                    const t = Math.min(dur - 0.01, Math.max(0, dur * frac));
                    v.currentTime = t;
                    await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 250); });
                    const c = document.createElement('canvas');
                    c.width = v.videoWidth; c.height = v.videoHeight;
                    const ctx = c.getContext('2d')!;
                    ctx.drawImage(v, 0, 0);
                    const d = ctx.getImageData(x, y, 1, 1).data;
                    samples.push({ t: Math.round(t * 100) / 100, r: d[0], g: d[1], b: d[2] });
                }
                URL.revokeObjectURL(url);
                return { w: v.videoWidth, h: v.videoHeight, dur, samples };
            }, { x, y, fractions });
        }

        // Column of the brightest pixel — the test video has a white dot moving
        // right 3px/frame, so a real export shows the dot at different columns at
        // different times. A frozen or black export would never move.
        async function brightestColumn(page: Page, t: number) {
            return page.evaluate(async ({ t }) => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                const url = URL.createObjectURL(f);
                const v = document.createElement('video');
                v.preload = 'auto'; v.muted = true; v.playsInline = true;
                await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('load failed')); v.src = url; });
                if (!isFinite(v.duration) || v.duration <= 0) {
                    v.currentTime = 1e7;
                    await new Promise<void>((res) => { v.onseeked = () => res(); });
                }
                const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime;
                v.currentTime = Math.min(dur - 0.01, Math.max(0, t));
                await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 250); });
                const c = document.createElement('canvas');
                c.width = v.videoWidth; c.height = v.videoHeight;
                const ctx = c.getContext('2d')!;
                ctx.drawImage(v, 0, 0);
                const img = ctx.getImageData(0, 0, c.width, c.height);
                let bestX = -1, best = 0;
                for (let x = 0; x < c.width; x++) {
                    let sum = 0;
                    for (let y = 0; y < c.height; y++) {
                        const i = (y * c.width + x) * 4;
                        sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
                    }
                    if (sum > best) { best = sum; bestX = x; }
                }
                URL.revokeObjectURL(url);
                return { t: Math.round(t * 100) / 100, bestX };
            }, { t });
        }

        // Stub uploadFileToServer to capture the exact bytes startFileUpload sends,
        // click confirm-upload, then analyze the captured file.
        async function analyzeSentFile(page: Page) {
            await page.evaluate(() => {
                const w = window as any;
                w.__sentFile = null;
                w.uploadFileToServer = async (file: File) => {
                    w.__sentFile = file;
                    return { file_id: 'captured-test', file_key: 'k', url: '' };
                };
            });
            await page.click('#confirm-upload');
            await page.waitForFunction(() => (window as any).__sentFile !== null, { timeout: 30000 });
            return page.evaluate(async () => {
                const f = (window as any).__sentFile as File;
                const url = URL.createObjectURL(f);
                const v = document.createElement('video');
                v.preload = 'auto'; v.muted = true; v.playsInline = true;
                await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('load failed')); v.src = url; });
                if (!isFinite(v.duration) || v.duration <= 0) {
                    v.currentTime = 1e7;
                    await new Promise<void>((res) => { v.onseeked = () => res(); });
                }
                const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime;
                const samples: any[] = [];
                for (const frac of [0.05, 0.5, 0.95]) {
                    const t = Math.min(dur - 0.01, Math.max(0, dur * frac));
                    v.currentTime = t;
                    await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 250); });
                    const c = document.createElement('canvas');
                    c.width = v.videoWidth; c.height = v.videoHeight;
                    const ctx = c.getContext('2d')!;
                    ctx.drawImage(v, 0, 0);
                    const d = ctx.getImageData(40, 30, 1, 1).data;
                    samples.push({ t: Math.round(t * 100) / 100, r: d[0], g: d[1], b: d[2] });
                }
                URL.revokeObjectURL(url);
                return { name: f.name, type: f.type, size: f.size, w: v.videoWidth, h: v.videoHeight, dur, samples };
            });
        }

        test('cropped export plays with visible frames across the whole duration', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 20, 30);
            expect(res.w).toBe(80);
            expect(res.h).toBe(60);
            expect(res.dur).toBeGreaterThan(0.5);
            expect(res.samples.length).toBe(4);
            for (const s of res.samples) {
                // Red half of the crop stays red through the whole duration.
                expect(s.r, `frame at ${s.t}s went black`).toBeGreaterThan(150);
            }
            const blue = await sampleVideoFrames(page, 60, 30);
            for (const s of blue.samples) {
                expect(s.b, `frame at ${s.t}s went black`).toBeGreaterThan(150);
            }
        });

        test('rotated and cropped export plays with visible frames', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 40, 30);
            expect(res.w).toBe(80);
            expect(res.h).toBe(60);
            expect(res.dur).toBeGreaterThan(0.5);
            for (const s of res.samples) {
                expect(s.r + s.g + s.b, `frame at ${s.t}s went black`).toBeGreaterThan(20);
            }
        });

        test('mirrored and cropped export plays with visible frames', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-mirror');
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 40, 30);
            expect(res.w).toBe(80);
            expect(res.h).toBe(60);
            expect(res.dur).toBeGreaterThan(0.5);
            for (const s of res.samples) {
                // Mirrored crop shows the blue (formerly right) half at x=40.
                expect(s.b, `frame at ${s.t}s went black`).toBeGreaterThan(150);
            }
        });

        test('rotated, mirrored and cropped export plays with visible frames', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-btn-mirror');
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 40, 30);
            expect(res.w).toBe(80);
            expect(res.h).toBe(60);
            expect(res.dur).toBeGreaterThan(0.5);
            for (const s of res.samples) {
                expect(s.r + s.g + s.b, `frame at ${s.t}s went black`).toBeGreaterThan(20);
            }
        });

        test('cut + crop export plays with visible frames', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page, 1.2);
            await openVideoEdit(page);
            await page.click('#video-tool-cut');
            // Cut to half (0.6s of content): the MediaRecorder timeslice padding
            // inflates the resolved duration a little, so keep clear of 1.0s.
            await dragCutEndTo(page, 0.5);
            // Diagnostic: the cut must survive switching to the crop tool.
            const cutEnd = await page.evaluate(() => (window as any).videoEditState.cutEnd);
            expect(cutEnd).toBeLessThan(0.7);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 20, 30);
            expect(res.w).toBe(80);
            expect(res.h).toBe(60);
            expect(res.dur).toBeGreaterThan(0.4);
            expect(res.dur).toBeLessThan(1.0);
            for (const s of res.samples) {
                expect(s.r, `frame at ${s.t}s went black`).toBeGreaterThan(150);
            }
        });

        test('exported video really plays: frames change over time (moving dot)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const a = await brightestColumn(page, 0.55);
            const b = await brightestColumn(page, 1.05);
            // The white dot moves 3px/frame at ~30fps: t=0.55 → x≈48, t=1.05 → x≈93.
            expect(Math.abs(b.bestX - a.bestX)).toBeGreaterThan(20);
        });

        test('crop at the corner never exports a black video (regression)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-tool-crop');
            // Box pinned to the TOP-LEFT corner, 40x30. The old offset math drew
            // the region shifted left/up by (frame-crop)/2, which for corner crops
            // landed entirely outside the video -> black export.
            await page.evaluate(() => {
                (window as any)._videoSetCropBox(0, 0, 40, 30);
            });
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const res = await sampleVideoFrames(page, 10, 10);
            expect(res.w).toBe(40);
            expect(res.h).toBe(30);
            for (const s of res.samples) {
                // Top-left corner of the source is the red half: never black.
                expect(s.r, `corner frame at ${s.t}s went black`).toBeGreaterThan(150);
            }
        });

        test('the file actually sent to the server is a playable cropped video', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await openVideoEdit(page);
            await page.click('#video-btn-rotate-right');
            await page.click('#video-tool-crop');
            await page.fill('#video-crop-w', '80');
            await page.fill('#video-crop-h', '60');
            await page.click('#video-crop-confirm');
            await page.click('#video-edit-confirm');
            await expect(page.locator('#video-edit-modal')).toBeHidden({ timeout: 20000 });
            const sent = await analyzeSentFile(page);
            expect(sent.name).toBe('test-video.webm');
            expect(sent.type).toBe('video/webm');
            expect(sent.size).toBeGreaterThan(0);
            expect(sent.w).toBe(80);
            expect(sent.h).toBe(60);
            expect(sent.dur).toBeGreaterThan(0.5);
            for (const s of sent.samples) {
                expect(s.r + s.g + s.b, `sent frame at ${s.t}s went black`).toBeGreaterThan(20);
            }
        });
    });

    test.describe('Audio Edit Modal', () => {

        test('quick actions show Edit for audio files (mirror/rotate hidden)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(burstSamples()));
            await expect(page.locator('#upload-quick-actions')).toBeVisible();
            await expect(page.locator('#upload-btn-mirror')).toBeHidden();
            await expect(page.locator('#upload-btn-rotate-left')).toBeHidden();
            await page.click('#upload-btn-edit');
            await expect(page.locator('#audio-edit-modal')).toBeVisible({ timeout: 8000 });
        });

        test('audio cut keeps only the selected range', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(twoToneSamples(1)));
            await openAudioEdit(page);
            // Cut to keep the second half (880Hz) of the 2s two-tone file.
            await dragCutStartToPrefix(page, 'audio', 0.5);
            const st = await page.evaluate(() => (window as any).audioEditState.cutStart);
            expect(st).toBeGreaterThan(0.4);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 10000 });
            const wav = parseWav(await currentAudioBytes(page));
            expect(wav.duration).toBeGreaterThan(0.85);
            expect(wav.duration).toBeLessThan(1.15);
            // The exported start is the 880Hz tone (ZCR ~1760/s), not 440Hz (~880/s).
            expect(zcr(wav.samples, 0, 0.2, wav.rate)).toBeGreaterThan(1300);
            // Magic-byte check passes and it decodes as a playable file.
            expect(await magicCheckCurrent(page)).toBeNull();
            const decode = await page.evaluate(async () => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                const ctx = new AudioContext();
                const ab = await f.arrayBuffer();
                const buf = await ctx.decodeAudioData(ab.slice(0));
                const d = buf.duration;
                await ctx.close();
                return d;
            });
            expect(decode).toBeGreaterThan(0.85);
            expect(decode).toBeLessThan(1.15);
        });

        test('webm source stays webm after editing (format + content preserved)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestWebm(page);
            await openAudioEdit(page);
            // Keep the first half (440Hz) of the 440→880 two-tone webm.
            await dragCutEndToPrefix(page, 'audio', 0.5);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 15000 });
            const meta = await page.evaluate(() => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                return { name: f.name, type: f.type, size: f.size };
            });
            expect(meta.name).toBe('test-audio.webm');
            expect(meta.type).toBe('audio/webm');
            expect(meta.size).toBeGreaterThan(300);
            // EBML magic bytes and the G5 check (audio/webm is now validated).
            expect((await currentAudioBytes(page)).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
            expect(await magicCheckCurrent(page)).toBeNull();
            // Decodes and the cut range is the 440Hz half (ZCR ~880/s, ~0.6s).
            const dec = await decodeAudioStats(page);
            expect(dec.duration).toBeGreaterThan(0.4);
            expect(dec.duration).toBeLessThan(0.75);
            expect(dec.zcr).toBeGreaterThan(600);
            expect(dec.zcr).toBeLessThan(1200);
        });

        test('mp3 source stays mp3 when encodable, else falls back to a valid WAV', async ({ page }) => {
            await registerAndSetup(page);
            // WAV bytes named .mp3 — decodeAudioData sniffs the container, so
            // the edit flow runs; the dispatch is keyed off the source name.
            await uploadTestAudio(page, wavBuffer(twoToneSamples(1)), 'test-audio.mp3');
            await openAudioEdit(page);
            await dragCutStartToPrefix(page, 'audio', 0.5); // keep the 880Hz half
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 15000 });
            const meta = await page.evaluate(() => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                return { name: f.name, type: f.type };
            });
            // Chromium cannot encode mp3 today → WAV fallback. Where a browser
            // does support mp3, the export must be a valid ID3 mp3 instead.
            expect(['test-audio.mp3', 'test-audio.wav']).toContain(meta.name);
            if (meta.name.endsWith('.mp3')) {
                expect(meta.type).toBe('audio/mpeg');
                expect((await currentAudioBytes(page)).subarray(0, 3).toString('ascii')).toBe('ID3');
            } else {
                expect(meta.type).toBe('audio/wav');
                const wav = parseWav(await currentAudioBytes(page));
                // The exported start is the 880Hz tone.
                expect(zcr(wav.samples, 0, 0.2, wav.rate)).toBeGreaterThan(1300);
            }
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('ogg source falls back to a valid WAV (no browser ogg encoder)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(twoToneSamples(1)), 'test-audio.ogg');
            await openAudioEdit(page);
            await dragCutStartToPrefix(page, 'audio', 0.5);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 15000 });
            const meta = await page.evaluate(() => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                return { name: f.name, type: f.type };
            });
            expect(meta.name).toBe('test-audio.wav');
            expect(meta.type).toBe('audio/wav');
            expect(await magicCheckCurrent(page)).toBeNull();
            const wav = parseWav(await currentAudioBytes(page));
            expect(zcr(wav.samples, 0, 0.2, wav.rate)).toBeGreaterThan(1300);
        });

        test('mp3 ID3 wrapper produces a magic-valid mp3 header', async ({ page }) => {
            // chat.js (with the editor code) only loads on index.html.
            await registerAndSetup(page);
            const res = await page.evaluate(() => {
                const frames = [new Uint8Array([0xff, 0xfb, 0x90, 0x64]), new Uint8Array([0xff, 0xfb, 0x90, 0x64])];
                const u8 = new Uint8Array((window as any)._mp3WithId3(frames));
                return { first3: String.fromCharCode(u8[0], u8[1], u8[2]), len: u8.length, sizeBytes: Array.from(u8.slice(6, 10)) };
            });
            expect(res.first3).toBe('ID3');
            expect(res.len).toBe(10 + 8);
            expect(res.sizeBytes).toEqual([0, 0, 0, 0]);
        });

        test('uploading an edited webm audio succeeds end-to-end', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestWebm(page);
            await openAudioEdit(page);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 15000 });
            await confirmUploadAndWait(page);
        });

        test('audio mirror reverses the audio (burst moves to the tail)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(burstSamples()));
            await openAudioEdit(page);
            await page.click('#audio-btn-mirror');
            expect(await page.evaluate(() => (window as any).audioEditState.reversed)).toBe(true);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 10000 });
            const wav = parseWav(await currentAudioBytes(page));
            // The 880Hz burst that started at t=0 is now at the END.
            expect(rms(wav.samples, 0.75, 0.95, wav.rate)).toBeGreaterThan(0.05);
            expect(rms(wav.samples, 0, 0.2, wav.rate)).toBeLessThan(0.02);
            expect(zcr(wav.samples, 0.75, 0.95, wav.rate)).toBeGreaterThan(1300);
            expect(await magicCheckCurrent(page)).toBeNull();
        });

        test('audio volume amplification boosts the samples', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(sineSamples(1, 440, 0.5)));
            await openAudioEdit(page);
            await page.locator('#audio-vol-slider').fill('200');
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 10000 });
            const wav = parseWav(await currentAudioBytes(page));
            // 0.5 amp x 2.0 gain = 1.0 (clamped) — near full scale.
            expect(peak(wav.samples)).toBeGreaterThan(0.9);
        });

        test('audio volume deamplification quiets the samples', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(sineSamples(1, 440, 0.5)));
            await openAudioEdit(page);
            await page.locator('#audio-vol-slider').fill('50');
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 10000 });
            const wav = parseWav(await currentAudioBytes(page));
            // 0.5 amp x 0.5 gain = 0.25.
            expect(peak(wav.samples)).toBeGreaterThan(0.18);
            expect(peak(wav.samples)).toBeLessThan(0.32);
        });

        test('audio undo/redo restores the reverse state', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(burstSamples()));
            await openAudioEdit(page);
            await page.click('#audio-btn-mirror');
            expect(await page.evaluate(() => (window as any).audioEditState.reversed)).toBe(true);
            await page.click('#audio-undo');
            expect(await page.evaluate(() => (window as any).audioEditState.reversed)).toBe(false);
            await page.click('#audio-redo');
            expect(await page.evaluate(() => (window as any).audioEditState.reversed)).toBe(true);
        });

        test('audio preview plays and stops', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(burstSamples()));
            await openAudioEdit(page);
            await page.click('#audio-cut-play');
            await expect(page.locator('#audio-cut-play')).toHaveText('⏸ Stop Preview');
            expect(await page.evaluate(() => (window as any)._audioPreviewPlaying)).toBe(true);
            await page.click('#audio-cut-play');
            await expect(page.locator('#audio-cut-play')).toHaveText('▶ Preview');
            expect(await page.evaluate(() => (window as any)._audioPreviewPlaying)).toBe(false);
        });

        test('audio cut timeline shows a seconds ruler', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(twoToneSamples(1)));
            await openAudioEdit(page);
            const ticks = await page.evaluate(() => ({
                count: document.getElementById('audio-cut-ruler')!.children.length,
                total: (document.getElementById('audio-cut-total') as HTMLElement).textContent,
            }));
            expect(ticks.count).toBeGreaterThanOrEqual(2);
            expect(ticks.total).toBe('of 0:02');
        });

        test('uploading an edited audio file succeeds end-to-end (no magic-byte error)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(burstSamples()));
            await openAudioEdit(page);
            await page.click('#audio-btn-mirror');
            await dragCutEndToPrefix(page, 'audio', 0.75);
            await page.click('#audio-edit-confirm');
            await expect(page.locator('#audio-edit-modal')).toBeHidden({ timeout: 10000 });
            await confirmUploadAndWait(page);
        });
    });

    test.describe('Video Quick Actions', () => {

        test('quick rotate transforms the actual video file (not cosmetic)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await page.click('#upload-btn-rotate-right');
            const out = await page.evaluate(async () => {
                const f = (0, eval)('selectedFiles[currentFileIndex]');
                const idx = (0, eval)('currentFileIndex');
                const outFile = await (window as any)._applyUploadTransformsToFile(f, idx);
                const url = URL.createObjectURL(outFile);
                return await new Promise<any>((resolve) => {
                    const v = document.createElement('video');
                    v.preload = 'auto';
                    v.muted = true;
                    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve({ w: v.videoWidth, h: v.videoHeight, size: outFile.size, type: outFile.type }); };
                    v.onerror = () => resolve({ w: -1, h: -1, size: outFile.size, type: outFile.type });
                    v.src = url;
                });
            });
            expect(out.type).toBe('video/webm');
            expect(out.size).toBeGreaterThan(0);
            expect(out.w).toBe(120);
            expect(out.h).toBe(160);
        });

        test('uploading a quick-transformed video succeeds end-to-end (no magic-byte error)', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await page.click('#upload-btn-mirror');
            await page.click('#upload-btn-rotate-right');
            await confirmUploadAndWait(page);
        });
    });

    test.describe('Media Loop & Theme Settings', () => {

        test('media viewer has a loop button that toggles video.loop', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestVideo(page);
            await confirmUploadAndWait(page);
            // Inline video preview renders; clicking opens the media viewer.
            const inlineVideo = page.locator('.file-preview video').first();
            await expect(inlineVideo).toBeVisible({ timeout: 20000 });
            await inlineVideo.click();
            await expect(page.locator('#media-viewer')).toBeVisible({ timeout: 5000 });
            const viewerVideo = page.locator('#media-viewer-content video');
            await expect(viewerVideo).toBeAttached();
            const loopBtn = page.locator('#vc-loop');
            await expect(loopBtn).toBeVisible();

            // Loop starts off.
            expect(await viewerVideo.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false);

            // Click -> on, button highlights.
            await loopBtn.click();
            expect(await viewerVideo.evaluate((v: HTMLVideoElement) => v.loop)).toBe(true);
            await expect(loopBtn).toHaveClass(/active/);

            // Click again -> off, highlight gone.
            await loopBtn.click();
            expect(await viewerVideo.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false);
            await expect(loopBtn).not.toHaveClass(/active/);
        });

        test('inline audio preview has a loop button that toggles audio.loop', async ({ page }) => {
            await registerAndSetup(page);
            await uploadTestAudio(page, wavBuffer(twoToneSamples(1)));
            await confirmUploadAndWait(page);
            const inlineAudio = page.locator('.file-preview audio').first();
            await expect(inlineAudio).toBeVisible({ timeout: 20000 });
            const loopBtn = page.locator('.file-preview .inline-loop-btn').first();
            await expect(loopBtn).toBeVisible();

            // Loop starts off.
            expect(await inlineAudio.evaluate((a: HTMLAudioElement) => a.loop)).toBe(false);

            // Click -> on, button highlights.
            await loopBtn.click();
            expect(await inlineAudio.evaluate((a: HTMLAudioElement) => a.loop)).toBe(true);
            await expect(loopBtn).toHaveClass(/active/);

            // Click again -> off, highlight gone.
            await loopBtn.click();
            expect(await inlineAudio.evaluate((a: HTMLAudioElement) => a.loop)).toBe(false);
            await expect(loopBtn).not.toHaveClass(/active/);
        });

        test('theme hex inputs initialize to the current color on a fresh profile', async ({ page }) => {
            await registerAndSetup(page);
            await page.click('#settings-btn');
            await expect(page.locator('#settings-modal')).toBeVisible({ timeout: 5000 });
            await page.click('.settings-tab[data-tab="display-settings"]');
            await expect(page.locator('#display-settings')).toBeVisible();

            // Fresh user: hex inputs initialize to the default color (not empty).
            expect(await page.inputValue('#theme-color-hex')).toBe('#4fc3f7');
            expect(await page.inputValue('#theme-bg-hex')).toBe('#4fc3f7');
            // Swatches remain passive previews (not interactive buttons).
            expect(await page.evaluate(() => getComputedStyle(document.querySelector('#theme-color-preview .theme-swatch') as HTMLElement).cursor)).not.toBe('pointer');
        });
    });
});
