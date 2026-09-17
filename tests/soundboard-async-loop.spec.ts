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

// Install a page-side WAV builder (real decodable PCM WAV → base64).
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

// Upload a real (encrypted) clip to the account's soundboard library.
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

async function sendCounts(page: any) {
    return await page.evaluate(() => {
        const s = (window as any).__sends || [];
        return {
            plays: s.filter((m: any) => m.type === 'soundboard_play').length,
            stops: s.filter((m: any) => m.type === 'soundboard_stop').length,
        };
    });
}

async function setToggles(page: any, opts: { selfHear: boolean; loop: boolean }) {
    await page.evaluate((o: any) => {
        const sh = document.getElementById('soundboard-self-hear') as HTMLInputElement;
        sh.checked = o.selfHear;
        sh.dispatchEvent(new Event('change'));
        const lp = document.getElementById('soundboard-loop') as HTMLInputElement;
        lp.checked = o.loop;
        lp.dispatchEvent(new Event('change'));
    }, opts);
}

// Fire the "echo" a real voice room would deliver back to the player, using the
// temp token the client just uploaded. `durationMs` keeps the local playback
// short so a natural end (and therefore a loop re-cycle) happens quickly.
async function simulateEcho(page: any, durationMs: number) {
    await page.evaluate((durationMs: number) => {
        const w = window as any;
        const msg = w.__sends.find((m: any) => m.type === 'soundboard_play');
        if (!msg) throw new Error('no soundboard_play was sent');
        const now = Date.now();
        w._handleSoundboardPlay({
            user_id: w.currentUserId,
            clip_id: msg.clip_id,
            temp_token: msg.temp_token,
            play_start_ms: now,
            server_now_ms: now,
            duration_ms: durationMs,
            loop: true,
            room_type: 'server', server_id: 'srv', channel_id: 'ch',
            _sbRecvLocalMs: now,
        });
    }, durationMs);
}

test.describe('Soundboard async playback: mute/unmute resume, clock skew, loop, owner disable', () => {

    test('A1: mute then unmute resumes the clip mid-playback (audible, not from 0)', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sba1'));
        await waitForWs(page);
        await installWavBuilder(page);
        await page.evaluate(() => {
            const w = window as any;
            w.VoiceManager.getVoiceState = () => ({ inVoice: true, roomType: 'server', serverId: 'srv', channelId: 'ch', dmChannelId: '' });
            w.currentServerId = 'srv';
        });

        // 8s clip that started 2s ago
        await page.evaluate(() => (window as any)._sbToggleMuteUser('user_X'));
        await page.evaluate(() => {
            const w = window as any;
            w._handleSoundboardPlay({
                user_id: 'user_X', clip_id: 'clipA1',
                encrypted_audio: w.__mkWavB64(8),
                play_start_ms: Date.now() - 2000,
                duration_ms: 8000,
                _lateJoinOffset: 0,
                room_type: 'server', server_id: 'srv', channel_id: 'ch',
            });
        });
        await page.waitForTimeout(600);

        let state = await page.evaluate(() => ({
            entries: (window as any)._sbAllPlaying.length,
            playing: !!(window as any)._sbPlayingUsers?.['user_X'],
        }));
        expect(state.entries).toBe(0);          // muted → not heard
        expect(state.playing).toBe(false);      // and no "playing" indicator

        // ~6s into the 8s clip: unmute → resume must land ~2s from the end
        await page.waitForTimeout(3500);
        await page.evaluate(() => {
            (window as any)._sbToggleMuteUser('user_X');
            (window as any)._sbResumeForUser('user_X');
        });
        await page.waitForTimeout(700);
        const resumed: any = await page.evaluate(() => {
            const w = window as any;
            const e = (w._sbAllPlaying || [])[0];
            return {
                entries: (w._sbAllPlaying || []).length,
                playing: !!(w._sbPlayingUsers || {})['user_X'],
                // The Audio-element fallback exposes the applied start offset.
                // (Playwright's headless Chromium ships no audio decoder, so the
                // AudioContext path rejects and the element carries playback; in
                // a real browser the same offset goes to source.start().)
                offsetMs: e && typeof e.currentTime === 'number' ? Math.round(e.currentTime * 1000) : null,
            };
        });
        expect(resumed.playing).toBe(true);          // audible again after unmute
        expect(resumed.entries).toBeGreaterThanOrEqual(1);
        // MUST be mid-clip: a restart-from-0 (or the old silent no-op) fails here
        if (resumed.offsetMs !== null) expect(resumed.offsetMs).toBeGreaterThan(5000);
    });

    test('A2: server_now_ms makes the offset immune to client clock skew', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sba2'));
        await waitForWs(page);
        await installWavBuilder(page);

        const res = await page.evaluate(async () => {
            const w = window as any;
            const wav = w.__mkWavB64(8);
            const real = Date.now();
            const playMsg = (offsetMs: number) => ({
                user_id: 'skewuser', clip_id: 'skewclip',
                encrypted_audio: wav,
                play_start_ms: real - offsetMs,   // SERVER clock
                server_now_ms: real,              // SERVER clock, at relay
                duration_ms: 8000,
                _lateJoinOffset: 0,
                room_type: 'server', server_id: 'srv', channel_id: 'ch',
            });

            // Pretend this client's clock is ONE HOUR ahead of the server. The
            // old `Date.now() - play_start_ms` math produced a 3605s offset and
            // skipped the clip as "already finished" — the reported
            // "join mid-play and hear nothing" bug.
            const origNow = Date.now;
            Date.now = () => origNow() + 3600 * 1000;

            w._handleSoundboardPlay(playMsg(5000));   // 5s into an 8s clip → audible
            await new Promise((r: any) => setTimeout(r, 1500));
            const playingMid = w._sbAllPlaying.length;
            const midEntry = (w._sbAllPlaying || [])[0];
            const midOffsetMs = midEntry && typeof midEntry.currentTime === 'number'
                ? Math.round(midEntry.currentTime * 1000) : null;
            w._stopAllSoundboardAudioAll();

            w._handleSoundboardPlay(playMsg(9000));   // 9s into an 8s clip → finished, must skip
            await new Promise((r: any) => setTimeout(r, 1500));
            const playingOver = w._sbAllPlaying.length;

            Date.now = origNow;
            w._stopAllSoundboardAudioAll();
            return { playingMid, playingOver, midOffsetMs };
        });

        expect(res.playingMid).toBeGreaterThanOrEqual(1);
        expect(res.playingOver).toBe(0);
        // and it landed at the real position (5s in), despite the +1h clock
        if (res.midOffsetMs !== null) expect(res.midOffsetMs).toBeGreaterThan(3500);
    });

    test('A3: Loop re-relays the clip instead of stopping; OFF/leave stop it', async ({ page }) => {
        test.setTimeout(180000);
        await register(page, unique('sba3'));
        await waitForWs(page);
        await installWavBuilder(page);
        const clipId = await uploadClip(page, 'loop_' + Date.now(), 0.6);
        await mockVoiceAndSpySends(page);
        await page.evaluate(async () => { await (window as any)._loadSoundboardClips(); });

        // Cycle boundaries are driven through the Hear-Myself-OFF timer path:
        // Playwright's headless Chromium can't decode audio, so a real onended
        // never fires — the timer is the same production trigger used when a
        // player keeps Hear Myself off.
        const playAndEcho = async (durationMs: number) => {
            await page.evaluate((cid: string) => (window as any)._playSoundboardClip(cid), clipId);
            await page.waitForFunction(() => ((window as any).__sends || []).some((m: any) => m.type === 'soundboard_play'), { timeout: 20000 });
            await simulateEcho(page, durationMs);
        };

        // --- Loop ON: the clip must be re-relayed, never stopped -------------
        await setToggles(page, { selfHear: false, loop: true });
        await page.evaluate(() => { (window as any).__sends.length = 0; });
        await playAndEcho(600);
        await page.waitForTimeout(4000);
        let counts = await sendCounts(page);
        expect(counts.plays).toBeGreaterThanOrEqual(2);
        expect(counts.stops).toBe(0);

        // --- Loop OFF: exactly one relay, no re-cycle ------------------------
        await setToggles(page, { selfHear: false, loop: false });
        await page.evaluate(() => {
            (window as any)._stopAllSoundboardAudioAll();
            (window as any).__sends.length = 0;
        });
        await playAndEcho(600);
        await page.waitForTimeout(4000);
        counts = await sendCounts(page);
        expect(counts.plays).toBe(1);

        // --- Leaving/stopping mid-cycle kills the loop ----------------------
        await setToggles(page, { selfHear: false, loop: true });
        await page.evaluate(() => { (window as any).__sends.length = 0; });
        await playAndEcho(600);
        // Simulate hang-up / kick / teardown right as the cycle is running.
        await page.evaluate(() => {
            (window as any)._sbClearLoopSession();
            (window as any)._stopAllSoundboardAudioAll();
            (window as any).__sends.length = 0;
        });
        await page.waitForTimeout(3500);
        counts = await sendCounts(page);
        expect(counts.plays).toBe(0);   // the loop must NOT keep broadcasting
    });

    test('A4: live owner disable stops our playback and blocks new plays until re-enabled', async ({ page }) => {
        test.setTimeout(180000);
        await register(page, unique('sba4'));
        await waitForWs(page);
        await installWavBuilder(page);
        const clipId = await uploadClip(page, 'owner_' + Date.now(), 0.6);
        await mockVoiceAndSpySends(page);
        await page.evaluate(async () => { await (window as any)._loadSoundboardClips(); });

        // Self-hear playback running (as the room would relay it back to us)
        await page.evaluate(() => {
            const w = window as any;
            const now = Date.now();
            w._handleSoundboardPlay({
                user_id: w.currentUserId, clip_id: 'live_clip',
                encrypted_audio: w.__mkWavB64(6),
                play_start_ms: now, duration_ms: 6000,
                _lateJoinOffset: 0,
                room_type: 'server', server_id: 'srv', channel_id: 'ch',
            });
        });
        await page.waitForTimeout(1200);
        const before = await page.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(before).toBeGreaterThanOrEqual(1);

        // Owner disables us live (server broadcast)
        await page.evaluate(() => {
            (window as any)._handleSoundboardDisabled({
                server_id: 'srv', user_id: (window as any).currentUserId, disabled: true,
            });
        });
        await page.waitForTimeout(400);
        const afterDisable = await page.evaluate(() => ({
            entries: (window as any)._sbAllPlaying.length,
            playing: Object.keys((window as any)._sbPlayingUsers || {}).length,
        }));
        expect(afterDisable.entries).toBe(0);
        expect(afterDisable.playing).toBe(0);

        // Clicking play while disabled must not reach the room
        await page.evaluate((cid: string) => (window as any)._playSoundboardClip(cid), clipId);
        await page.waitForTimeout(1500);
        expect((await sendCounts(page)).plays).toBe(0);

        // Re-enabled → playing works again
        await page.evaluate(() => {
            const w = window as any;
            w._handleSoundboardDisabled({ server_id: 'srv', user_id: w.currentUserId, disabled: false });
            w.__sends.length = 0;
        });
        await page.evaluate((cid: string) => (window as any)._playSoundboardClip(cid), clipId);
        await page.waitForFunction(() => ((window as any).__sends || []).some((m: any) => m.type === 'soundboard_play'), { timeout: 20000 });
        expect((await sendCounts(page)).plays).toBeGreaterThanOrEqual(1);
    });
});
