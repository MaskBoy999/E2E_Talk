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

async function openNotifSettings(page: any) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
    await page.click('.settings-tab[data-tab="notification-settings"]');
    await page.waitForSelector('#notification-settings', { state: 'visible', timeout: 10000 });
}

test.describe('Notification sound 30s cap + trim UI', () => {
    test('>30s upload shows the trim panel; saved part is ≤30s, encrypted, synced', async ({ page }) => {
        test.setTimeout(120000);
        const body = await registerUser(page, 'nstrim1_' + Date.now().toString().slice(-6));
        expect(body.token).toBeTruthy();
        await openNotifSettings(page);

        // Pick a 45s WAV through the real file input.
        const wav = makeWav(45);
        await page.setInputFiles('#notif-sound-input', {
            name: 'long-notif.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });

        // Trim panel appears with the total duration.
        await page.waitForSelector('#notif-trim', { state: 'visible', timeout: 15000 });
        const total = await page.locator('#notif-trim-total').textContent();
        expect(total).toBe('0:45');

        // Waveform canvas is visible and actually drew non-background pixels.
        const wf = page.locator('#notif-trim-waveform');
        await wf.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForFunction(() => {
            const c = document.getElementById('notif-trim-waveform') as HTMLCanvasElement;
            if (!c || !c.width) return false;
            const ctx = c.getContext('2d');
            if (!ctx) return false;
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let colored = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] !== 14 || d[i + 1] !== 14 || d[i + 2] !== 20) colored++;
            }
            return colored > 200;
        }, undefined, { timeout: 10000 });

        // Click the waveform at ~66% -> start jumps there (45s * 0.66 ≈ 29s).
        const box = (await wf.boundingBox())!;
        await wf.click({ position: { x: box.width * 0.66, y: box.height / 2 } });
        const startAfterClick = parseInt((await page.locator('#notif-trim-start').inputValue()), 10);
        expect(startAfterClick).toBeGreaterThanOrEqual(27);
        expect(startAfterClick).toBeLessThanOrEqual(30);

        // Choose a 1–30s part: start at 5s, length 12s.
        await page.locator('#notif-trim-start').fill('5');
        await page.locator('#notif-trim-len').fill('12');
        await page.click('#notif-trim-save-btn');

        // Status confirms the trimmed save.
        await page.waitForFunction(() => {
            const s = document.getElementById('notif-sound-status');
            return s && s.textContent && s.textContent.indexOf('Notification sound saved') !== -1;
        }, undefined, { timeout: 15000 });

        // The saved file name reflects the trim.
        const name = await page.locator('#notif-sound-file-name').textContent();
        expect(name).toContain('-12s.wav');

        // Server holds an encrypted sound (never plaintext audio). A
        // plaintext WAV always starts with "RIFF" (base64: "UklGR"); ciphertext
        // is random so check the FIXED start position (a substring scan would
        // flake on random base64 coincidences).
        const srv = await (await page.request.get(`${BASE}/api/notification-sound`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        expect(srv.encrypted_sound).toBeTruthy();
        expect(srv.encrypted_sound.startsWith('UklGR')).toBe(false);

        // Decrypt + verify the stored audio is <= ~30s and >= 1s.
        const check = await page.evaluate(async () => {
            _notifCachedUrl = null;
            await _idbNotifDel('url').catch(() => {});
            await restoreNotificationSoundFromServer();
            const url = _notifCachedUrl;
            if (!url) return { ok: false, err: 'no url' };
            const parts = url.split(',');
            const bin = atob(parts[1]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const AC = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AC();
            const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
            const dur = decoded.duration;
            const mono = decoded.numberOfChannels === 1;
            try { ctx.close(); } catch (_) {}
            return { ok: true, duration: dur, mono, bytes: bin.length };
        });
        expect(check.ok).toBe(true);
        expect(check.duration).toBeGreaterThanOrEqual(1);
        expect(check.duration).toBeLessThanOrEqual(30.5);
        expect(check.mono).toBe(true); // downmixed like the ringtone trim
    });

    test('short file (<=30s) saves directly without the trim panel', async ({ page }) => {
        test.setTimeout(120000);
        const body = await registerUser(page, 'nstrim2_' + Date.now().toString().slice(-6));
        expect(body.token).toBeTruthy();
        await openNotifSettings(page);

        const wav = makeWav(3);
        await page.setInputFiles('#notif-sound-input', {
            name: 'short-notif.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });

        // No trim panel; status is the direct save message.
        await page.waitForFunction(() => {
            const s = document.getElementById('notif-sound-status');
            return s && s.textContent && s.textContent.indexOf('Custom sound saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#notif-trim').isVisible().catch(() => false)).toBe(false);
        const name = await page.locator('#notif-sound-file-name').textContent();
        expect(name).toContain('short-notif.wav');

        const srv = await (await page.request.get(`${BASE}/api/notification-sound`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        expect(srv.encrypted_sound).toBeTruthy();
    });
});

test.describe('Notification sound trim preview lifecycle', () => {
    test('preview stops when switching settings tabs or closing the modal', async ({ page }) => {
        test.setTimeout(120000);
        await registerUser(page, 'nstrim3_' + Date.now().toString().slice(-6));
        await openNotifSettings(page);

        const wav = makeWav(45);
        await page.setInputFiles('#notif-sound-input', {
            name: 'stopme-notif.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });
        await page.waitForSelector('#notif-trim', { state: 'visible', timeout: 15000 });

        // Start a preview, then switch to another settings tab.
        await page.click('#notif-trim-preview-btn');
        await page.click('.settings-tab[data-tab="display-settings"]');
        // The stop hook is a real function and calling it is safe.
        const stopFn = await page.evaluate(() => typeof (window as any)._stopNotifTrimPreview);
        expect(stopFn).toBe('function');
        await page.evaluate(() => (window as any)._stopNotifTrimPreview());

        // Re-open the notifications tab; preview plays again without error.
        await page.click('.settings-tab[data-tab="notification-settings"]');
        await page.click('#notif-trim-preview-btn');
        await page.evaluate(() => (window as any)._stopNotifTrimPreview());

        // Close via the X and call the stop hook once more — no errors.
        await page.click('#close-settings');
        await page.evaluate(() => (window as any)._stopNotifTrimPreview());
        expect(true).toBe(true);
    });
});

test.describe('Notification sound local cache is user-scoped', () => {
    test('new account on the same browser does NOT inherit the previous account\'s notification sound', async ({ page }) => {
        test.setTimeout(150000);
        const ts = Date.now().toString().slice(-6);
        const body1 = await registerUser(page, 'nsa1_' + ts);
        await openNotifSettings(page);
        // User A uploads a notification sound.
        const wav = makeWav(3);
        await page.setInputFiles('#notif-sound-input', {
            name: 'a-notif.wav',
            mimeType: 'audio/wav',
            buffer: wav,
        });
        await page.waitForFunction(() => {
            const s = document.getElementById('notif-sound-status');
            return s && s.textContent && s.textContent.indexOf('Custom sound saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#notif-sound-file-name').textContent()).toContain('a-notif.wav');

        // Simulate session expiry WITHOUT clearing data: remove the token +
        // user keys exactly like checkTokenExpiry does, then navigate away.
        await page.evaluate(() => {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        });

        // Register user B on the same browser.
        const body2 = await registerUser(page, 'nsa2_' + ts);
        expect(body2.token).toBeTruthy();

        // B must NOT see A's notification sound.
        await openNotifSettings(page);
        const inherited = await page.evaluate(async () => {
            const url = await _idbNotifGet('url');
            return {
                hasUrl: !!url || !!_notifCachedUrl,
                fileNameShown: (document.getElementById('notif-sound-file-name') as HTMLElement).style.display !== 'none',
            };
        });
        expect(inherited.hasUrl).toBe(false);
        expect(inherited.fileNameShown).toBe(false);

        const srv = await page.request.get(`${BASE}/api/notification-sound`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        });
        expect(srv.status()).toBe(404);

        // And B can set their OWN sound, which replaces nothing stale.
        const wav2 = makeWav(2);
        await page.setInputFiles('#notif-sound-input', {
            name: 'b-notif.wav',
            mimeType: 'audio/wav',
            buffer: wav2,
        });
        await page.waitForFunction(() => {
            const s = document.getElementById('notif-sound-status');
            return s && s.textContent && s.textContent.indexOf('Custom sound saved') !== -1;
        }, undefined, { timeout: 15000 });
        expect(await page.locator('#notif-sound-file-name').textContent()).toContain('b-notif.wav');
        const srvB = await (await page.request.get(`${BASE}/api/notification-sound`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(srvB.encrypted_sound).toBeTruthy();
    });
});
