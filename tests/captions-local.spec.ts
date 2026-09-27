import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Live captions, in the shape the user asked for: transcribed ON THIS DEVICE
 * from each participant's own decrypted audio, with the speech model bundled in
 * the app — and nothing published to anyone.
 *
 * What this spec pins down (all of it runs against the real server page, the
 * real worker and the real bundled model):
 *
 *   1. The model, its runtime and its wasm are served by the app's own origin
 *      with the MIME types the browser needs (a missing or mis-typed vendored
 *      file would break captions for every user, silently, at runtime).
 *   2. Turning captions on loads that model and reports readiness.
 *   3. Feeding one participant's PCM (exactly what their stream tap feeds)
 *      produces a caption line LABELLED with that speaker and containing real
 *      recognised words.
 *   4. A silent window produces nothing — the energy gate means a quiet call
 *      never invents text.
 *   5. Enabling and running captions performs no cross-origin request at all:
 *      no CDN, no speech service, nothing that could carry decrypted audio or
 *      its transcript off the device.
 *   6. The publish path is gone: no `__voiceSendCaption`, no publish toggle, and
 *      a `caption` signal from an older client is not displayed.
 *
 * The WAV fixture is ~4.7 s of Windows SAPI speech ("hello this is a test of
 * offline speech recognition in the desktop app"), committed so the assertion is
 * deterministic; regenerate it with:
 *   powershell -c "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
 *     $s.SetOutputToWaveFile('hello-captions.wav'); $s.Speak('hello this is a test of offline speech recognition in the desktop app'); $s.Dispose()"
 */

const BASE = 'https://localhost:3443';
const WAV = join(__dirname, 'fixtures', 'hello-captions.wav');

// The model has to load inside the browser before anything can be recognised.
test.describe.configure({ timeout: 300000 });

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', `caps_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

test.describe('local captions', () => {
    test('the bundled model and its runtime are served by the app itself', async ({ request }) => {
        const js = [
            '/vendor/asr/transformers.min.js',
            '/captions-asr-worker.js',
        ];
        for (const path of js) {
            const res = await request.get(`${BASE}${path}`);
            expect(res.status(), `${path} must be served by our own origin`).toBe(200);
            const type = res.headers()['content-type'] || '';
            // An ES module loaded with the wrong MIME type is refused outright,
            // because every response carries `X-Content-Type-Options: nosniff`.
            expect(type, `${path} needs a javascript content type, got "${type}"`).toContain('javascript');
        }
        // The model's own files are JSON, and JSON is exactly what the loader
        // expects for them.
        for (const path of [
            '/vendor/asr/whisper-tiny/config.json',
            '/vendor/asr/whisper-tiny/tokenizer.json',
        ]) {
            const res = await request.get(`${BASE}${path}`);
            expect(res.status(), `${path} must be served by our own origin`).toBe(200);
            expect(res.headers()['content-type'] || '', `${path} needs a JSON content type`).toContain('json');
        }
        for (const path of [
            '/vendor/asr/ort-wasm-simd-threaded.jsep.mjs',
            '/vendor/asr/ort-wasm-simd-threaded.jsep.wasm',
            '/vendor/asr/whisper-tiny/onnx/encoder_model_quantized.onnx',
            '/vendor/asr/whisper-tiny/onnx/decoder_model_merged_quantized.onnx',
        ]) {
            const res = await request.get(`${BASE}${path}`);
            expect(res.status(), `${path} must be served by our own origin`).toBe(200);
        }
        const wasm = await request.get(`${BASE}/vendor/asr/ort-wasm-simd-threaded.jsep.wasm`);
        expect(wasm.headers()['content-type']).toContain('wasm');
    });

    test('transcribes a participant locally, labels the speaker, and never reaches out', async ({ page }) => {
        const external: string[] = [];
        page.on('request', (req) => {
            const url = req.url();
            if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
        });

        await registerAndSetup(page);

        // The publish path must be gone, UI and JS alike.
        expect(await page.locator('#captions-publish-toggle').count()).toBe(0);
        expect(await page.evaluate(() => typeof (window as any).__voiceSendCaption)).toBe('undefined');
        expect(await page.locator('#captions-language').count()).toBe(1);

        const wavB64 = readFileSync(WAV).toString('base64');

        // Decode the fixture to 16 kHz mono PCM exactly the way the tap delivers it.
        const pcm = await page.evaluate(async (b64: string) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const ctx = new AudioContext({ sampleRate: 16000 });
            const buf = await ctx.decodeAudioData(bytes.buffer);
            const data = Array.from(buf.getChannelData(0));
            await ctx.close();
            return { data, rate: buf.sampleRate };
        }, wavB64);
        expect(pcm.data.length).toBeGreaterThan(16000);

        // Two CDN scripts are part of the QR-code UI and load on every visit;
        // everything AFTER this point is the caption pipeline and must be local.
        const preExisting = external.length;

        // Turn captions on from the real control.
        await page.evaluate(() => {
            const t = document.getElementById('captions-toggle') as HTMLInputElement;
            t.checked = true;
            t.dispatchEvent(new Event('change'));
        });
        await expect
            .poll(async () => page.evaluate(() => (window as any).__captions.modelState().state), { timeout: 240000 })
            .toBe('ready');

        // Feed one participant's window.
        const accepted = await page.evaluate(({ data, rate }) => {
            return (window as any).__captions._feedForTest('peer-uid-1', 'Alice', new Float32Array(data), rate);
        }, pcm);
        expect(accepted, 'a speech window must be accepted').toBe(true);

        await expect
            .poll(async () => page.evaluate(() => {
                const lines = (window as any).__captions.lines();
                return lines.length ? lines[lines.length - 1].who + ': ' + lines[lines.length - 1].text : '';
            }), { timeout: 120000 })
            .toContain('Alice:');

        const line = await page.evaluate(() => {
            const lines = (window as any).__captions.lines();
            return lines[lines.length - 1];
        });
        expect(line.text.toLowerCase()).toContain('speech recognition');
        // …and it is on screen, in the panel, with the speaker named.
        await expect(page.locator('#captions-panel')).toHaveClass(/captions-open/);
        await expect(page.locator('.captions-who').last()).toHaveText('Alice');

        // A second speaker gets their own label.
        await page.evaluate(({ data, rate }) => {
            (window as any).__captions._feedForTest('peer-uid-2', 'Bob', new Float32Array(data), rate);
        }, pcm);
        await expect
            .poll(async () => page.evaluate(() => {
                const lines = (window as any).__captions.lines();
                return lines.map((l: any) => l.who).join(',');
            }), { timeout: 120000 })
            .toContain('Bob');

        // Silence must not invent a line.
        const before = await page.evaluate(() => (window as any).__captions.lines().length);
        const quiet = await page.evaluate(() => {
            const silence = new Float32Array(16000 * 5);
            return (window as any).__captions._feedForTest('peer-uid-3', 'Carol', silence, 16000);
        });
        expect(quiet, 'a silent window is dropped by the energy gate').toBe(false);
        expect(await page.evaluate(() => (window as any).__captions.lines().length)).toBe(before);

        // Nothing was fetched from anywhere but the app's own origin while
        // captions were loading and transcribing: no model CDN, no speech
        // service, nothing that could carry audio or transcript off device.
        expect(external.slice(preExisting), 'captions must not touch the network').toEqual([]);

        // Stopping drops every line (captions are never written down).
        await page.evaluate(() => (window as any).__captions.stop());
        expect(await page.evaluate(() => (window as any).__captions.lines().length)).toBe(0);
        expect(await page.evaluate(() => (window as any).__captions.isRunning())).toBe(false);
    });

    test('a caption pushed by an older client is ignored, not displayed', async ({ page }) => {
        await registerAndSetup(page);
        // The handler no longer exists at all — that is the assertion.
        expect(await page.evaluate(() => typeof (window as any).__captionsShowRemote)).toBe('undefined');
        // And with captions never turned on there is not even a panel to show.
        expect(await page.locator('#captions-panel').count()).toBe(0);
    });
});
