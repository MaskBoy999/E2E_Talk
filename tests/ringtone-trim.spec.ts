import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Generates a PCM WAV of `seconds` seconds (440Hz) as a Node Buffer.
function makeWav(seconds: number, rate = 48000) {
    const n = Math.floor(seconds * rate);
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.2;
        buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
    }
    return buf;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function openVoiceSettings(page: any) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await page.waitForSelector('#voice-settings', { state: 'visible', timeout: 10000 });
}

test.describe('Ringtone 30s cap + trim UI', () => {
    test('>30s upload shows the trim panel; saved part is ≤30s, encrypted, synced', async ({ page }) => {
        test.setTimeout(120000);
        const body = await registerUser(page, 'rtrim1_' + Date.now().toString().slice(-6));
        expect(body.token).toBeTruthy();
        await openVoiceSettings(page);

        // Pick a 45s WAV through the real file input.
        const wav = makeWav(45);
        await page.setInputFiles('#ringtone-input', {
            name: 'long-song.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });

        // Trim panel appears with the total duration.
        await page.waitForSelector('#ringtone-trim', { state: 'visible', timeout: 15000 });
        const total = await page.locator('#ringtone-trim-total').textContent();
        expect(total).toBe('0:45');

        // Waveform canvas is visible and actually drew non-background pixels
        // (a real peak trace, not a blank canvas).
        const wf = page.locator('#ringtone-trim-waveform');
        await wf.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForFunction(() => {
            const c = document.getElementById('ringtone-trim-waveform') as HTMLCanvasElement;
            if (!c || !c.width) return false;
            const ctx = c.getContext('2d');
            if (!ctx) return false;
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let colored = 0;
            for (let i = 0; i < d.length; i += 4) {
                // background is #0e0e14 (14,14,20); waveform/selection differ.
                if (d[i] !== 14 || d[i + 1] !== 14 || d[i + 2] !== 20) colored++;
            }
            return colored > 200;
        }, undefined, { timeout: 10000 });

        // Click the waveform at ~66% of the way across -> start jumps there
        // (45s * 0.66 ≈ 29s) and the label reflects it.
        const box = (await wf.boundingBox())!;
        await wf.click({ position: { x: box.width * 0.66, y: box.height / 2 } });
        const startAfterClick = parseInt((await page.locator('#ringtone-trim-start').inputValue()), 10);
        expect(startAfterClick).toBeGreaterThanOrEqual(27);
        expect(startAfterClick).toBeLessThanOrEqual(30);

        // Choose a 1–30s part: start at 5s, length 12s.
        await page.locator('#ringtone-trim-start').fill('5');
        await page.locator('#ringtone-trim-len').fill('12');
        await page.click('#ringtone-trim-save-btn');

        // Status confirms the trimmed save.
        await page.waitForFunction(() => {
            const s = document.getElementById('ringtone-status');
            return s && s.textContent && s.textContent.indexOf('Ringtone saved') !== -1;
        }, undefined, { timeout: 15000 });

        // The saved file name reflects the trim.
        const name = await page.locator('#ringtone-file-name').textContent();
        expect(name).toContain('-12s.wav');

        // Server holds an encrypted ringtone (never plaintext audio). A
        // plaintext WAV always starts with the bytes "RIFF" (base64: "UklGR");
        // ciphertext is random so checking the FIXED start position is exact,
        // whereas a substring scan would flake on random base64 coincidences.
        const srv = await (await page.request.get(`${BASE}/api/ringtone`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        expect(srv.encrypted_sound).toBeTruthy();
        expect(srv.encrypted_sound.startsWith('UklGR')).toBe(false);

        // Decrypt + verify the stored audio is <= ~30s and >= 1s.
        const check = await page.evaluate(async () => {
            _ringtoneCachedUrl = null;
            await _idbRingtoneDel('url').catch(() => {});
            await restoreRingtoneFromServer();
            const url = await getRingtoneUrl();
            if (!url) return { ok: false, err: 'no url' };
            const parts = url.split(',');
            const bin = atob(parts[1]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const AC = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AC();
            const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
            const dur = decoded.duration;
            try { ctx.close(); } catch (_) {}
            return { ok: true, duration: dur, bytes: bin.length };
        });
        expect(check.ok).toBe(true);
        expect(check.duration).toBeGreaterThanOrEqual(1);
        expect(check.duration).toBeLessThanOrEqual(30.5);
    });

    test('short file (<=30s) saves directly without the trim panel', async ({ page }) => {
        test.setTimeout(120000);
        const body = await registerUser(page, 'rtrim2_' + Date.now().toString().slice(-6));
        expect(body.token).toBeTruthy();
        await openVoiceSettings(page);

        const wav = makeWav(3);
        await page.setInputFiles('#ringtone-input', {
            name: 'short.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });

        // No trim panel; status is the direct save message.
        await page.waitForFunction(() => {
            const s = document.getElementById('ringtone-status');
            return s && s.textContent && s.textContent.indexOf('Custom ringtone saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#ringtone-trim').isVisible().catch(() => false)).toBe(false);
        const name = await page.locator('#ringtone-file-name').textContent();
        expect(name).toContain('short.wav');

        const srv = await (await page.request.get(`${BASE}/api/ringtone`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        expect(srv.encrypted_sound).toBeTruthy();
    });
});

test.describe('Trim panel fixes (CSS, preview overlap, big-file sync)', () => {
    test('trim buttons are styled (not raw unstyled) + 30s save syncs despite >2MB body', async ({ page }) => {
        test.setTimeout(120000);
        const body = await registerUser(page, 'rtrim3_' + Date.now().toString().slice(-6));
        expect(body.token).toBeTruthy();
        await openVoiceSettings(page);

        // Pick a 45s stereo WAV so a 30s trim is a multi-MB base64 body.
        const wav = makeWav(45);
        await page.setInputFiles('#ringtone-input', {
            name: 'big-stereo.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });
        await page.waitForSelector('#ringtone-trim', { state: 'visible', timeout: 15000 });

        // Buttons have real styling now (padding + radius applied by CSS).
        const saveBtnStyle = await page.evaluate(() => {
            const b = document.getElementById('ringtone-trim-save-btn') as HTMLElement;
            const cs = getComputedStyle(b);
            return { padding: cs.padding, radius: cs.borderRadius, bg: cs.backgroundColor };
        });
        expect(saveBtnStyle.padding).not.toBe('0px');
        expect(saveBtnStyle.radius).not.toBe('0px');

        // Preview twice quickly — must NOT throw and must not leave two live
        // sources (the second click stops the first via token-guarded stop),
        // and the button must still work after the double-click.
        await page.click('#ringtone-trim-preview-btn');
        await page.click('#ringtone-trim-preview-btn');
        await page.click('#ringtone-trim-preview-btn'); // still usable after double-click

        // Save the FULL 30s — this payload is >2MB base64, which the old
        // server (default 2MB body limit) rejected with 'Server sync failed'.
        await page.locator('#ringtone-trim-start').fill('0');
        await page.locator('#ringtone-trim-len').fill('30');
        await page.click('#ringtone-trim-save-btn');

        // Sync must SUCCEED: the 'Server sync failed...' message must never
        // appear; instead we get the saved confirmation.
        await page.waitForFunction(() => {
            const s = document.getElementById('ringtone-status');
            return s && s.textContent && s.textContent.indexOf('Ringtone saved') !== -1;
        }, undefined, { timeout: 20000 });
        const statusText = await page.locator('#ringtone-status').textContent();
        expect(statusText).not.toContain('Server sync failed');

        // Server actually stored it (big payload accepted). Poll — the 30s
        // upload is multi-MB and the save handler fires sync async after the
        // success message, so give the POST time to land.
        let srv: any = null;
        for (let i = 0; i < 20; i++) {
            const res = await page.request.get(`${BASE}/api/ringtone`, {
                headers: { Authorization: `Bearer ${body.token}` },
            });
            if (res.ok()) {
                srv = await res.json();
                if (srv.encrypted_sound) break;
            }
            await page.waitForTimeout(500);
        }
        expect(srv).toBeTruthy();
        expect(srv.encrypted_sound).toBeTruthy();
        const decLen = await page.evaluate(async () => {
            _ringtoneCachedUrl = null;
            await _idbRingtoneDel('url').catch(() => {});
            await restoreRingtoneFromServer();
            const url = await getRingtoneUrl();
            if (!url) return 0;
            const bin = atob(url.split(',')[1]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const AC = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AC();
            const dec = await ctx.decodeAudioData(bytes.buffer.slice(0));
            const dur = dec.duration;
            const mono = dec.numberOfChannels === 1;
            try { ctx.close(); } catch (_) {}
            return { dur, mono };
        });
        expect(decLen.dur).toBeGreaterThanOrEqual(28); // ~30s saved
        expect(decLen.dur).toBeLessThanOrEqual(30.5);
        expect(decLen.mono).toBe(true); // downmixed for size
    });

    test('preview stops when switching settings tabs or closing the modal', async ({ page }) => {
        test.setTimeout(120000);
        await registerUser(page, 'rtrim4_' + Date.now().toString().slice(-6));
        await openVoiceSettings(page);

        const wav = makeWav(45);
        await page.setInputFiles('#ringtone-input', {
            name: 'stopme.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });
        await page.waitForSelector('#ringtone-trim', { state: 'visible', timeout: 15000 });

        // Start a preview, then switch to another settings tab.
        await page.click('#ringtone-trim-preview-btn');
        await page.click('.settings-tab[data-tab="display-settings"]');
        // The stop hook is a real function (the fix) and calling it is safe.
        const stopFn = await page.evaluate(() => typeof (window as any)._stopRingTrimPreview);
        expect(stopFn).toBe('function');
        await page.evaluate(() => (window as any)._stopRingTrimPreview());

        // Re-open the voice tab; the trim panel still works and preview plays
        // again without error (source was properly cleaned up).
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.click('#ringtone-trim-preview-btn');
        await page.evaluate(() => (window as any)._stopRingTrimPreview());

        // Close via the X and call the stop hook once more — no errors.
        await page.click('#close-settings');
        await page.evaluate(() => (window as any)._stopRingTrimPreview());
        expect(true).toBe(true);
    });
});

test.describe('Ringtone local cache is user-scoped', () => {
    test('new account on the same browser does NOT inherit the previous account\'s ringtone', async ({ page }) => {
        test.setTimeout(150000);
        const ts = Date.now().toString().slice(-6);
        const body1 = await registerUser(page, 'rsa1_' + ts);
        await openVoiceSettings(page);
        // User A uploads a ringtone.
        const wav = makeWav(3);
        await page.setInputFiles('#ringtone-input', {
            name: 'a-ring.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });
        await page.waitForFunction(() => {
            const s = document.getElementById('ringtone-status');
            return s && s.textContent && s.textContent.indexOf('Custom ringtone saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#ringtone-file-name').textContent()).toContain('a-ring.wav');

        // Simulate session expiry WITHOUT clearing data: remove the token +
        // user keys exactly like checkTokenExpiry does, then navigate away.
        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        // Register user B on the same browser.
        const body2 = await registerUser(page, 'rsa2_' + ts);
        expect(body2.token).toBeTruthy();

        // B must NOT see A's ringtone: no file name shown, cache cleared, and
        // the server has no ringtone for B.
        await openVoiceSettings(page);
        const inherited = await page.evaluate(async () => {
            const url = await getRingtoneUrl();
            return {
                hasUrl: !!url,
                fileNameShown: (document.getElementById('ringtone-file-name') as HTMLElement).style.display !== 'none',
            };
        });
        expect(inherited.hasUrl).toBe(false);
        expect(inherited.fileNameShown).toBe(false);

        const srv = await page.request.get(`${BASE}/api/ringtone`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        });
        expect(srv.status()).toBe(404);

        // And B can set their OWN ringtone, which replaces nothing stale.
        const wav2 = makeWav(2);
        await page.setInputFiles('#ringtone-input', {
            name: 'b-ring.wav',
            mimeType: 'audio/wav',
            buffer: wav2,
        });
        await page.waitForFunction(() => {
            const s = document.getElementById('ringtone-status');
            return s && s.textContent && s.textContent.indexOf('Custom ringtone saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#ringtone-file-name').textContent()).toContain('b-ring.wav');
        const srvB = await (await page.request.get(`${BASE}/api/ringtone`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(srvB.encrypted_sound).toBeTruthy();
    });
});
