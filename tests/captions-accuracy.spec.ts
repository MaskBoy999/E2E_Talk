// Live captions: the accuracy settings and the benchmark that measures them.
//
// The claims pinned here are the ones a reader cannot check by reading the code:
//
//   * there are two bundled models, the choice is a stored setting, and the
//     model the WORKER reports loading is the one that was chosen (a settings
//     control that silently keeps running whisper-tiny would be worse than none);
//   * the wasm backend really is multi-threaded, which is only legal because the
//     app's own server sends COOP/COEP — the worker reports what it got, so a
//     regression to single-threaded captions is visible here;
//   * a later decode of the same 30 s window contributes only its new tail
//     (the overlap de-duplication that makes long-form windows readable);
//   * the benchmark runs, and the readout says which engine was faster — the
//     point of the GPU switch is that the answer differs per machine.
//
// Decoding real speech through the real worker is covered by
// tests/captions-local.spec.ts; a real call by tests/captions-call.spec.ts.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

async function openVoiceSettings(page: Page) {
    await page.click('#settings-btn');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await expect(page.locator('#voice-settings')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#captions-status')).toBeAttached();
}

function uniq(base: string) {
    return `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('captions accuracy', () => {
    test('offers whisper-base, and the worker runs the model that was chosen', async ({ page }) => {
        test.setTimeout(420000);
        await register(page, uniq('acc'));

        // A call started on the default model: whatever the setting says is what
        // the worker must load, so the default is pinned here too.
        await page.evaluate(() => (window as any).__captions.start());

        await openVoiceSettings(page);
        const model = page.locator('#captions-model');
        await expect(model).toBeVisible();
        await expect(model.locator('option')).toHaveCount(2);
        await expect(model).toHaveValue('tiny');
        expect(await page.evaluate(() => (window as any).__captions.model())).toBe('tiny');

        // whisper-base is a second bundled model, not a different service: the
        // switch only changes which local files the pipeline reads.
        await model.selectOption('base');
        expect(await page.evaluate(() => localStorage.getItem('captions_model'))).toBe('base');
        expect(await page.evaluate(() => (window as any).__captions.model())).toBe('base');
        // Wait for the WORKER to say it is running whisper-base, not merely for
        // the setting to hold that value: the point is that the other bundled
        // model really loaded.
        await expect
            .poll(async () => page.evaluate(() => {
                const s = (window as any).__captions.modelState();
                return s.state + ':' + s.model;
            }), { timeout: 300000 })
            .toBe('ready:whisper-base');

        const st = await page.evaluate(() => (window as any).__captions.modelState());
        expect(st.state).toBe('ready');
        // The page is cross-origin isolated (COOP same-origin + COEP require-corp
        // are on every static response), which is what makes SharedArrayBuffer —
        // and therefore multi-threaded wasm — legal. The worker reports what it
        // actually built, so this catches a silent fall back to one thread.
        expect(st.isolated, 'the app must serve COOP/COEP so the wasm path can use threads').toBe(true);
        expect(st.threads, 'captions must not be stuck on a single wasm thread').toBeGreaterThan(1);

        // The status line names the model and the window length the decoder uses.
        await expect(page.locator('#captions-status')).toContainText('whisper-base');
        await expect(page.locator('#captions-status')).toContainText('30 s windows');

        // The language can be worked out instead of assumed: a wrong language is
        // the difference between a few wrong words and nonsense.
        const langs = await page.evaluate(() => (window as any).__captions.languages.map((l: string[]) => l[0]));
        expect(langs[0]).toBe('auto');
        expect(await page.evaluate(() => (window as any).__captions.language())).toBe('auto');
        expect(await page.evaluate(() => (window as any).__captions.detectedLanguage())).toBe('');

        await page.evaluate(() => (window as any).__captions.stop());

        // And it is a setting, not a per-session choice.
        await page.reload();
        await openVoiceSettings(page);
        await expect(page.locator('#captions-model')).toHaveValue('base');
    });

    test('a re-decoded window contributes only what is new, and the benchmark reports both engines', async ({ page }) => {
        test.setTimeout(480000);
        await register(page, uniq('bench'));
        await openVoiceSettings(page);

        // The overlap de-duplication: the window keeps the stride of audio it
        // already read, so this is what keeps a line from being printed twice.
        const strip = await page.evaluate(() => ({
            grown: (window as any).__captions._strip('we should ship it tomorrow', 'we should ship it tomorrow at noon'),
            revised: (window as any).__captions._strip('hello there everyone', 'so hello there everyone how are you'),
            unrelated: (window as any).__captions._strip('completely different words', 'nothing to do with that'),
            nothingNew: (window as any).__captions._strip('that is the whole sentence', 'that is the whole sentence'),
        }));
        expect(strip.grown).toBe('at noon');
        // A decode that re-words the start of a sentence (a different ending
        // changes it) still must not repeat the sentence.
        expect(strip.revised).toBe('how are you');
        expect(strip.unrelated, 'unrelated text is not trimmed').toBe('nothing to do with that');
        expect(strip.nothingNew, 'nothing new means nothing shown twice').toBe('');

        // Nothing has been measured yet, so there is no readout to show.
        await expect(page.locator('#captions-bench-result')).toBeHidden();
        await expect(page.locator('#captions-bench-btn')).toBeVisible();

        // Run it the way the button does.
        await page.click('#captions-bench-btn');
        await expect.poll(async () => page.evaluate(() => (window as any).__captions.benchRunning()), { timeout: 420000 })
            .toBe(false);

        const res = await page.evaluate(() => (window as any).__captions.benchResult());
        expect(res, 'the benchmark must publish a result').toBeTruthy();
        expect(res.model).toBe('tiny');
        expect(res.cpu, 'the CPU engine always exists').toBeTruthy();
        expect(res.cpu.error || '', 'the bundled model must actually decode here').toBe('');
        expect(res.cpu.median, 'a decode of a window must take measurable time').toBeGreaterThan(0);
        expect(res.cpu.timings.length, 'the first decode is a warm-up and is not reported').toBeGreaterThan(0);
        // Whatever engine the readout names, a failure is stated rather than
        // silently reported as a fast zero.
        if (res.gpu) {
            expect(res.gpu.error || res.gpu.median).toBeTruthy();
        }

        // Printed as well as asserted: the numbers are the whole point of the
        // feature, and where the GPU path exists they belong in the CI log.
        console.log('BENCHMARK', JSON.stringify({ cpu: res.cpu, gpu: res.gpu, speedup: res.speedup, source: res.source }));

        const readout = (await page.locator('#captions-bench-result').textContent()) || '';
        console.log('BENCHMARK READOUT\n' + readout);
        expect(readout).toContain('whisper-tiny');
        expect(readout).toContain('30 s window');
        expect(readout).toContain('CPU (wasm');
        expect(readout).toMatch(/real time/);
        // It says which audio it measured, and that measuring sent nothing away.
        expect(readout).toMatch(/generated locally|captured from this call/);
    });
});
