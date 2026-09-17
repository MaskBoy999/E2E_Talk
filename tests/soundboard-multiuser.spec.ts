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

function state(page: any) {
    return page.evaluate(() => {
        const w = window as any;
        const entries = w._sbAllPlaying || [];
        // Distinct players the page is currently playing (AudioContext entries
        // carry userId; fallback <audio> elements carry _sbUserId).
        const players = Array.from(new Set(entries.map((e: any) => e && (e.userId || e._sbUserId)).filter(Boolean)));
        return {
            entries: entries.length,
            players,
            badges: Object.keys(w._sbPlayingUsers || {}).sort(),
        };
    });
}

test.describe('Soundboard multi-user: several players at once', () => {

    test('M1: two players at once — muting one only silences that one, unmute resumes only that one', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbmu1'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        // Two people play different 12s clips simultaneously.
        await fakePlay(page, 'user_A', 'clipA', 12000);
        await fakePlay(page, 'user_B', 'clipB', 12000);
        await page.waitForTimeout(1500);

        let s = await state(page);
        expect(s.entries).toBe(2);
        expect(s.players.sort()).toEqual(['user_A', 'user_B']);
        expect(s.badges).toEqual(['user_A', 'user_B']);

        // Mute A (the voice-menu path): A goes silent, B keeps playing.
        await page.evaluate(() => {
            (window as any)._sbToggleMuteUser('user_A');
            (window as any)._sbStopLiveForUser('user_A');
        });
        await page.waitForTimeout(300);
        s = await state(page);
        expect(s.entries).toBe(1);
        expect(s.players).toEqual(['user_B']);
        expect(s.badges).toEqual(['user_B']);

        // Unmute A → only A comes back (mid-clip); B was never touched.
        await page.evaluate(() => {
            (window as any)._sbToggleMuteUser('user_A');
            (window as any)._sbResumeForUser('user_A');
        });
        await page.waitForTimeout(900);
        s = await state(page);
        expect(s.entries).toBe(2);
        expect(s.players.sort()).toEqual(['user_A', 'user_B']);
    });

    test('M2: a stop for one player leaves the other player playing', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbmu2'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        await fakePlay(page, 'user_A', 'clipA', 12000);
        await fakePlay(page, 'user_B', 'clipB', 12000);
        await page.waitForTimeout(1500);
        expect((await state(page)).entries).toBe(2);

        // A pressed stop / A's clip ended → the room stop is for A only.
        await page.evaluate(() => (window as any)._handleSoundboardStop({ user_id: 'user_A' }));
        await page.waitForTimeout(300);
        const s = await state(page);
        expect(s.entries).toBe(1);
        expect(s.players).toEqual(['user_B']);
        expect(s.badges).toEqual(['user_B']);
    });

    test('M3: owner-disabling one player stops only that player and keeps their resume record', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbmu3'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        await fakePlay(page, 'user_A', 'clipA', 12000);
        await fakePlay(page, 'user_B', 'clipB', 12000);
        await page.waitForTimeout(1500);

        // Server broadcasts the owner-disable stop with its reason.
        await page.evaluate(() => (window as any)._handleSoundboardStop({ user_id: 'user_A', reason: 'soundboard_disabled' }));
        await page.waitForTimeout(300);
        let s = await state(page);
        expect(s.entries).toBe(1);
        expect(s.players).toEqual(['user_B']);   // B is untouched by A's disable

        // A's resume record survived the disable stop, so re-enable can resume
        // A mid-clip... without disturbing B.
        await page.evaluate(() => (window as any)._sbResumeForUser('user_A'));
        await page.waitForTimeout(900);
        s = await state(page);
        expect(s.entries).toBe(2);
        expect(s.players.sort()).toEqual(['user_A', 'user_B']);
    });

    test('M4: our own clip coexists with another player; stopping ours leaves theirs playing', async ({ page }) => {
        test.setTimeout(120000);
        await register(page, unique('sbmu4'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        const myId = await page.evaluate(() => (window as any).currentUserId);
        await fakePlay(page, 'user_A', 'clipA', 12000);
        await fakePlay(page, myId, 'clipMine', 12000);
        await page.waitForTimeout(1500);

        let s = await state(page);
        expect(s.entries).toBe(2);
        expect(s.players.sort()).toEqual([myId, 'user_A'].sort());

        // Pressing our stop button stops OUR audio (+ broadcasts our stop) but
        // must not silence the other player. This mirrors the overlay button
        // handler exactly.
        await page.evaluate(() => {
            (window as any)._stopAllSoundboardAudio();
            (window as any)._sendSoundboardStop();
        });
        await page.waitForTimeout(300);
        s = await state(page);
        expect(s.entries).toBe(1);
        expect(s.players).toEqual(['user_A']);
        expect(s.badges).toEqual(['user_A']);
        // The stop we broadcast names US (the server only clears our own slot
        // and listeners only stop our clip) — never the other player.
        const stops = await page.evaluate((myId: string) => ((window as any).__sends || [])
            .filter((m: any) => m.type === 'soundboard_stop')
            .map((m: any) => m.user_id), myId);
        expect(stops.length).toBeGreaterThanOrEqual(1);
        expect(stops.every((uid: string) => uid === myId)).toBe(true);
    });

    test('M5: a skipped past-end late join never leaves a stuck playing badge for that user', async ({ page }) => {
        test.setTimeout(90000);
        await register(page, unique('sbmu5'));
        await waitForWs(page);
        await installWavBuilder(page);
        await mockVoiceAndSpySends(page);

        // A 1s clip whose server start is 10s ago → already finished.
        await page.evaluate(() => {
            const w = window as any;
            const now = Date.now();
            w._handleSoundboardPlay({
                user_id: 'user_longgone', clip_id: 'old', encrypted_audio: w.__mkWavB64(1),
                play_start_ms: now - 10000, server_now_ms: now, duration_ms: 1000,
                _sbRecvLocalMs: now, _lateJoinOffset: 0,
                room_type: 'server', server_id: 'srv', channel_id: 'ch',
            });
        });
        await page.waitForTimeout(1200);
        const s = await state(page);
        expect(s.entries).toBe(0);
        expect(s.badges).toEqual([]); // no phantom "playing" badge
    });
});

// ──────────────────────────────────────────────
// Server integration: several players in one real room
// ──────────────────────────────────────────────

async function createServerWithVoice(page: any): Promise<{ serverId: string; voiceChannelId: string }> {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 8000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 8000 });
    await page.fill('#new-server-name', 'MultiSB_' + Date.now());
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');
    const voiceChannelId = await page.evaluate(async (sid: string) => {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/servers/${sid}/channels`, { headers: { Authorization: `Bearer ${token}` } });
        const chs = await res.json();
        const arr = Array.isArray(chs) ? chs : (chs.channels || []);
        const vc = arr.find((c: any) => (c.channel_type || c.type) === 'voice');
        return vc ? vc.id : '';
    }, serverId);
    return { serverId, voiceChannelId };
}

async function connectUser(page1: any, page2: any, serverId: string) {
    const token1 = await page1.evaluate(() => localStorage.getItem('token'));
    const token2 = await page2.evaluate(() => localStorage.getItem('token'));
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { invite_code: code },
    });
    await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { code },
    });
    // Wait for the server key so the client can join voice / play in this room.
    await page2.evaluate(async (sid: string) => {
        for (let i = 0; i < 30; i++) {
            if ((window as any).E2ECrypto && (window as any).E2ECrypto.getServerKey(sid)) return;
            await new Promise((r: any) => setTimeout(r, 400));
        }
    }, serverId);
}

async function joinVoice(page: any, serverId: string, voiceChannelId: string) {
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.click(`.channel-item[data-id="${voiceChannelId}"]`);
    await page.waitForFunction(() => {
        const bar = document.getElementById('voice-bar');
        return bar && bar.style.display !== 'none';
    }, { timeout: 20000 });
}

async function uploadClip(page: any, name: string, durationSec: number): Promise<string> {
    return await page.evaluate(async ({ name, durationSec }: { name: string; durationSec: number }) => {
        const w = window as any;
        const b64 = w.__mkWavB64(durationSec);
        const raw = atob(b64);
        const wav = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) wav[i] = raw.charCodeAt(i);
        const E = w.E2ECrypto;
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

test.describe('Soundboard multi-user (server integration)', () => {

    test('M6: two players in one room — one stopping leaves the other playing for everyone', async ({ page }) => {
        test.setTimeout(300000);
        const u1 = unique('sbm6a');
        const u2 = unique('sbm6b');
        const u3 = unique('sbm6c');
        await register(page, u1);
        await waitForWs(page);
        await installWavBuilder(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);
        await installWavBuilder(page2);

        const ctx3 = await (page.context().browser() as any).newContext();
        const page3 = await ctx3.newPage();
        await register(page3, u3);
        await waitForWs(page3);
        await installWavBuilder(page3);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const clipA = await uploadClip(page, 'm6a_' + Date.now(), 30);
        const clipB = await uploadClip(page2, 'm6b_' + Date.now(), 30);
        await connectUser(page, page2, serverId);
        await connectUser(page, page3, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);
        await page3.reload();
        await page3.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page3);

        const u1Id = await page.evaluate(() => (window as any).currentUserId);
        const u2Id = await page2.evaluate(() => (window as any).currentUserId);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await joinVoice(page3, serverId, voiceChannelId);
        await page.waitForTimeout(1500);

        // Both play 30s clips; u3 (present the whole time) hears both.
        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page2.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipA);
        await page2.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipB);
        await page3.waitForFunction(() => ((window as any)._sbAllPlaying || []).length >= 2, { timeout: 30000 });

        // u1 stops its own sound (the overlay stop-button path).
        await page.evaluate(() => {
            (window as any)._stopAllSoundboardAudio();
            (window as any)._sendSoundboardStop();
        });
        await page3.waitForTimeout(2500);

        const s = await state(page3);
        expect(s.players).not.toContain(u1Id);   // u1's clip stopped everywhere
        expect(s.players).toContain(u2Id);       // u2 keeps playing
        expect(s.entries).toBeGreaterThanOrEqual(1);

        await ctx2.close();
        await ctx3.close();
    });

    test('M7: owner-disabling one of two players stops only that player for the room', async ({ page }) => {
        test.setTimeout(300000);
        const u1 = unique('sbm7a');
        const u2 = unique('sbm7b');
        const u3 = unique('sbm7c');
        await register(page, u1);
        await waitForWs(page);
        await installWavBuilder(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);
        await installWavBuilder(page2);

        const ctx3 = await (page.context().browser() as any).newContext();
        const page3 = await ctx3.newPage();
        await register(page3, u3);
        await waitForWs(page3);
        await installWavBuilder(page3);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const token1 = await page.evaluate(() => localStorage.getItem('token'));
        const clipB = await uploadClip(page2, 'm7b_' + Date.now(), 30);
        const clipC = await uploadClip(page3, 'm7c_' + Date.now(), 30);
        await connectUser(page, page2, serverId);
        await connectUser(page, page3, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);
        await page3.reload();
        await page3.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page3);

        const u2Id = await page2.evaluate(() => (window as any).currentUserId);
        const u3Id = await page3.evaluate(() => (window as any).currentUserId);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await joinVoice(page3, serverId, voiceChannelId);
        await page.waitForTimeout(1500);

        // u2 and u3 both play; u1 (the owner) hears both.
        await page2.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page3.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page2.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipB);
        await page3.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipC);
        await page.waitForFunction(() => ((window as any)._sbAllPlaying || []).length >= 2, { timeout: 30000 });

        // Owner disables ONLY u2.
        const dis = await page.request.put(`${BASE}/api/soundboard/disable/${serverId}/${u2Id}`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        });
        expect(dis.ok()).toBeTruthy();
        await page.waitForTimeout(2500);

        // On the owner's client: u2 is silent, u3 keeps playing.
        const ownerView = await state(page);
        expect(ownerView.players).not.toContain(u2Id);
        expect(ownerView.players).toContain(u3Id);

        // u2's own client stopped its self-hear, but disabling u2's SOUNDBOARD
        // does not stop u2 from HEARING others — u3 keeps playing for u2.
        const u2View = await state(page2);
        expect(u2View.players).not.toContain(u2Id);
        expect(u2View.players).toContain(u3Id);
        const u3Still = await state(page3);
        expect(u3Still.players).toContain(u3Id);

        await ctx2.close();
        await ctx3.close();
    });
});
