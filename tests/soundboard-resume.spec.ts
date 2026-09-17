import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PW = 'testpass123';

let counter = 0;
function unique(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`; }

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: any) {
    await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === 1, { timeout: 20000 });
}

// A real decodable WAV, base64 (same generator the other soundboard specs use).
async function installWavBuilder(page: any) {
    await page.evaluate(() => {
        (window as any).__mkWavB64 = function (secs: number) {
            const rate = 8000, n = Math.floor(rate * secs), dataSize = n * 2;
            const buf = new ArrayBuffer(44 + dataSize);
            const dv = new DataView(buf);
            const w8 = (o: number, v: number) => dv.setUint8(o, v);
            const w32 = (o: number, v: number) => dv.setUint32(o, v, true);
            const w16 = (o: number, v: number) => dv.setUint16(o, v, true);
            w32(0, 36 + dataSize);
            w8(4, 0x52); w8(5, 0x49); w8(6, 0x46); w8(7, 0x46);
            w8(8, 0x57); w8(9, 0x41); w8(10, 0x56); w8(11, 0x45);
            w8(12, 0x66); w8(13, 0x6D); w8(14, 0x74); w8(15, 0x20);
            w32(16, 16); w16(20, 1); w16(22, 1); w32(24, rate); w32(28, rate * 2);
            w16(32, 2); w16(34, 16);
            w8(36, 0x64); w8(37, 0x61); w8(38, 0x74); w8(39, 0x61); w32(40, dataSize);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
            const bytes = new Uint8Array(buf);
            let s = '';
            const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) {
                s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as any);
            }
            return btoa(s);
        };
    });
}

async function uploadClip(page: any, name: string, durationSec: number): Promise<string> {
    return await page.evaluate(async ({ name, durationSec }: { name: string; durationSec: number }) => {
        const b64 = (window as any).__mkWavB64(durationSec);
        const raw = atob(b64);
        const wav = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) wav[i] = raw.charCodeAt(i);
        const E = (window as any).E2ECrypto;
        const identity = E.getIdentityKeyPair();
        const enc = E.envelopeEncrypt(wav, identity.publicKey, identity.privateKey);
        const token = localStorage.getItem('token');
        const res = await fetch('/api/soundboard', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_id: '_global', name,
                encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce,
                duration_ms: Math.round(durationSec * 1000),
            }),
        });
        const data = await res.json();
        if (!data.ok && !data.id) throw new Error('upload failed: ' + JSON.stringify(data));
        return data.clip_id || data.id;
    }, { name, durationSec });
}

// Put the page "in voice" on a fake server room and spy on outgoing WS frames.
async function mockVoiceAndSpySends(page: any) {
    await page.evaluate(() => {
        const w = window as any;
        w.VoiceManager.getVoiceState = () => ({
            inVoice: true, roomType: 'server', serverId: 'srv',
            channelId: 'ch', dmChannelId: '',
        });
        w.currentServerId = 'srv';
        w.__sends = [];
        const orig = w.ws.send.bind(w.ws);
        w.ws.send = (m: string) => {
            try { w.__sends.push(JSON.parse(m)); } catch (_) { /* ignore */ }
            return orig(m);
        };
    });
}

// A play message as the server would relay it (skew-free play_start/server_now).
async function fakePlay(page: any, userId: string, clipId: string, durationMs: number) {
    await page.evaluate(({ userId, clipId, durationMs }: any) => {
        const w = window as any;
        const now = Date.now();
        w._handleSoundboardPlay({
            user_id: userId, clip_id: clipId,
            encrypted_audio: w.__mkWavB64(Math.round(durationMs / 1000)),
            play_start_ms: now, server_now_ms: now, duration_ms: durationMs,
            _sbRecvLocalMs: now, _lateJoinOffset: 0,
            room_type: 'server', server_id: 'srv', channel_id: 'ch',
        });
    }, { userId, clipId, durationMs });
}

function offscreenAudioOffset(page: any) {
    return page.evaluate(() => {
        const e = ((window as any)._sbAllPlaying || [])[0];
        return e && typeof e.currentTime === 'number' ? Math.round(e.currentTime * 1000) : null;
    });
}

test.describe('Soundboard resume / disable / overlay regressions', () => {

    test('R1: a clip ALREADY playing when muted resumes mid-clip on unmute', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbr1'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        // ~8s clip starts; not muted, so we hear it.
        await fakePlay(page, 'other_U', 'c1', 8000);
        await page.waitForTimeout(1200);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);

        // Mute the player exactly like the volume menu does: stop live audio
        // WITHOUT dropping the resume record.
        await page.evaluate(() => {
            (window as any)._sbToggleMuteUser('other_U');
            (window as any)._sbStopLiveForUser('other_U');
        });
        await page.waitForTimeout(300);
        // Live audio is gone — but the resume record survives (the unmute
        // assertion below can only pass if it did).
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBe(0);

        // ~2.5s later: unmute → must resume from ~3.5s in, not silence/0.
        await page.waitForTimeout(2500);
        await page.evaluate(() => {
            (window as any)._sbToggleMuteUser('other_U');
            (window as any)._sbResumeForUser('other_U');
        });
        await page.waitForTimeout(900);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);
        expect(await page.evaluate(() => !!(window as any)._sbPlayingUsers['other_U'])).toBe(true);
        const offset = await offscreenAudioOffset(page);
        if (offset !== null) expect(offset).toBeGreaterThan(2500);
    });

    test('R2: settings-disable stops our broadcast + blocks receive; re-enable resumes mid-clip', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbr2'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        await fakePlay(page, 'other_U', 'c2', 12000);
        await page.waitForTimeout(1200);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);

        // Turn the setting ON through the real checkbox handler.
        await page.evaluate(() => {
            const cb = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(400);

        const afterDisable = await page.evaluate(() => ({
            entries: (window as any)._sbAllPlaying.length,
            stops: ((window as any).__sends || []).filter((m: any) => m.type === 'soundboard_stop').length,
        }));
        expect(afterDisable.entries).toBe(0);         // receive blocked
        expect(afterDisable.stops).toBeGreaterThanOrEqual(1); // our own clip stopped for the room

        // Re-enable through the checkbox → the still-playing clip resumes.
        await page.evaluate(() => {
            const cb = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
        await page.waitForTimeout(900);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);
    });

    test('R4: reopening the overlay mid-play still shows the stop button', async ({ page }) => {
        test.setTimeout(150000);
        await register(page, unique('sbr4'));
        await waitForWs(page);
        await installWavBuilder(page);
        const clipId = await uploadClip(page, 'reopen_' + Date.now(), 20);
        await mockVoiceAndSpySends(page);
        await page.evaluate(async () => { await (window as any)._loadSoundboardClips(); });

        // Open the overlay and press this clip's play button with its real DOM
        // button elements, so the overlay knows the clip is active.
        await page.evaluate((cid: string) => {
            const ov = document.getElementById('soundboard-overlay');
            if (ov) ov.style.display = 'flex';
            const el = document.querySelector(`.soundboard-clip[data-clip-id="${cid}"]`) as HTMLElement;
            const play = el.querySelector('.sb-play-btn') as HTMLElement;
            (window as any)._playSoundboardClip(
                cid,
                el.querySelector('.sb-pause-btn'),
                play,
                el.querySelector('.sb-loading'));
        }, clipId);
        await page.waitForFunction(() => ((window as any).__sends || []).some((m: any) => m.type === 'soundboard_play'), { timeout: 20000 });
        await page.waitForTimeout(600);

        // Rebuild the list (what opening the overlay doesn't do, but a data
        // refresh / reopen does) — the active stop button must survive.
        await page.evaluate(async () => { await (window as any)._loadSoundboardClips(); });
        await page.waitForTimeout(300);

        const state = await page.evaluate((cid: string) => {
            const el = document.querySelector('.soundboard-clip[data-clip-id="' + cid + '"]');
            const pp = el?.querySelector('.sb-pause-btn') as HTMLElement;
            const pb = el?.querySelector('.sb-play-btn') as HTMLElement;
            return { pauseVisible: !!pp && pp.style.display !== 'none', playVisible: !!pb && pb.style.display !== 'none' };
        }, clipId);
        expect(state.pauseVisible).toBe(true);
        expect(state.playVisible).toBe(false);
    });

    test('R3: deafen stops the soundboard and undeafen resumes it mid-clip', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbr3'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        await fakePlay(page, 'other_U', 'c3', 12000);
        await page.waitForTimeout(1200);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);

        // Use the REAL production toggle (the same fn the voice-bar deafen
        // button calls) — not a raw state poke — so the wiring is covered.
        await page.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await page.waitForTimeout(300);
        const deaf = await page.evaluate(() => ({
            deafened: (window as any).VoiceManager.getState().deafened,
            entries: (window as any)._sbAllPlaying.length,
        }));
        expect(deaf.deafened).toBe(true);
        expect(deaf.entries).toBe(0); // deafening silences the soundboard

        // A clip that arrives while deafened must be suppressed (and remembered).
        await fakePlay(page, 'other_U2', 'c3b', 12000);
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBe(0);

        // Undeafen → the still-playing clips resume mid-way (like a late join).
        await page.waitForTimeout(1200);
        await page.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await page.waitForTimeout(1000);
        expect(await page.evaluate(() => (window as any).VoiceManager.getState().deafened)).toBe(false);
        expect(await page.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);
        expect(await page.evaluate(() => !!(window as any)._sbPlayingUsers['other_U'])).toBe(true);
        const offset = await offscreenAudioOffset(page);
        if (offset !== null) expect(offset).toBeGreaterThan(1500);
    });
});
