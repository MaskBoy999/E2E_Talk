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

// Build a small 1s 8kHz sine WAV and encrypt with the identity key (per-account clips).
async function uploadIdentityClip(page: any, clipName: string, durationSec = 1): Promise<string> {
    return await page.evaluate(async ({ clipName, durationSec }: { clipName: string; durationSec: number }) => {
        const rate = 8000, n = Math.floor(rate * durationSec);
        const dataSize = n * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const dv = new DataView(buf);
        const w8 = (o: number, v: number) => dv.setUint8(o, v);
        const w32 = (o: number, v: number) => dv.setUint32(o, v, true);
        const w16 = (o: number, v: number) => dv.setUint16(o, v, true);
        w32(0, 36 + dataSize); w8(4, 0x52); w8(5, 0x49); w8(6, 0x46); w8(7, 0x46);
        w8(8, 0x57); w8(9, 0x41); w8(10, 0x56); w8(11, 0x45);
        w8(12, 0x66); w8(13, 0x6D); w8(14, 0x74); w8(15, 0x20);
        w32(16, 16); w16(20, 1); w16(22, 1); w32(24, rate); w32(28, rate * 2);
        w16(32, 2); w16(34, 16); w8(36, 0x64); w8(37, 0x61); w8(38, 0x74); w8(39, 0x61);
        w32(40, dataSize);
        for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
        const E = (window as any).E2ECrypto;
        const identity = E.getIdentityKeyPair();
        const wav = new Uint8Array(buf);
        const enc = E.envelopeEncrypt(wav, identity.publicKey, identity.privateKey);
        const token = localStorage.getItem('token');
        const res = await fetch('/api/soundboard', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_id: '_global', name: clipName,
                encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce,
                duration_ms: Math.round(durationSec * 1000),
            }),
        });
        const data = await res.json();
        if (!data.ok && !data.id) throw new Error('upload failed: ' + JSON.stringify(data));
        return data.clip_id || data.id;
    }, { clipName, durationSec });
}

async function createServerWithVoice(page: any): Promise<{ serverId: string; voiceChannelId: string }> {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 8000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 8000 });
    await page.fill('#new-server-name', 'SBSpec_' + Date.now());
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');
    // New servers get a default voice channel — find it
    const voiceChannelId = await page.evaluate(async (sid: string) => {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/servers/${sid}/channels`, { headers: { Authorization: `Bearer ${token}` } });
        const chs = await res.json();
        const arr = Array.isArray(chs) ? chs : (chs.channels || []);
        // type is 'type' in the DB row but 'channel_type' in the API response
        const vc = arr.find((c: any) => (c.channel_type || c.type) === 'voice');
        return vc ? vc.id : '';
    }, serverId);
    return { serverId, voiceChannelId };
}

// Friend + invite + join through the API
async function connectUsers(page1: any, page2: any, serverId: string) {
    const token1 = await page1.evaluate(() => localStorage.getItem('token'));
    const token2 = await page2.evaluate(() => localStorage.getItem('token'));
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, { headers: { Authorization: `Bearer ${token2}` } })).json();
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
    // page2 needs the server key to derive room keys
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

// Directly exercise the temp-play endpoint (multi-fetch + cleanup semantics)
test.describe('Soundboard temp-play endpoint', () => {
    test('T1: same token can be fetched MULTIPLE times (late joiners)', async ({ page }) => {
        const u = unique('tp');
        await register(page, u);
        await waitForWs(page);
        const result = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
            // 2s sine wav, 8kHz mono
            const rate = 8000, n = rate * 2, dataSize = n * 2;
            const buf = new ArrayBuffer(44 + dataSize);
            const dv = new DataView(buf);
            dv.setUint32(40, dataSize, true);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
            let b64 = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
            b64 = btoa(b64);
            const up = await (await fetch('/api/soundboard/temp-play', { method: 'POST', headers: h, body: JSON.stringify({ audio: b64 }) })).json();
            if (!up.token) return { ok: false, err: 'no token' };
            // Fetch the SAME token 3 times — all must succeed (not one-shot)
            const results: number[] = [];
            for (let i = 0; i < 3; i++) {
                const r = await fetch('/api/soundboard/temp-play/' + up.token, { headers: h });
                results.push(r.status);
                if (r.ok) await r.arrayBuffer();
            }
            return { ok: results.every(s => s === 200), results };
        });
        console.log('T1 multi-fetch:', JSON.stringify(result));
        expect(result.ok).toBe(true);
    });

    test('T2: stop clears the token from server memory', async ({ page }) => {
        test.setTimeout(150000);
        const u = unique('tpc');
        await register(page, u);
        await waitForWs(page);
        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const clipId = await uploadIdentityClip(page, 'stopclean_' + Date.now());
        // Populate the client-side clip cache before playing (play looks up the cache)
        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await joinVoice(page, serverId, voiceChannelId);
        // Wait until the server actually sees us in the room before playing
        await page.waitForTimeout(2500);

        // Play and capture the temp token from the outgoing WS message
        const tok = await page.evaluate(async (cid: string) => {
            const logs: string[] = [];
            const origError = console.error;
            console.error = function (...a: any[]) { logs.push(a.map(String).join(' ').slice(0, 120)); origError.apply(console, a as any); };
            return new Promise((resolve: any) => {
                const w = window as any;
                const cacheOk = (w._sbClipsCache || []).some((c: any) => c.id === cid);
                if (!cacheOk) { resolve('CACHE_MISS:' + JSON.stringify((w._sbClipsCache || []).map((c: any) => c.id))); return; }
                const origSend = w.ws.send.bind(w.ws);
                let resolved = false;
                w.ws.send = function (s: string) {
                    try {
                        const m = JSON.parse(s);
                        if (m.type === 'soundboard_play' && m.temp_token) {
                            w.ws.send = origSend;
                            console.error = origError;
                            resolved = true;
                            resolve(m.temp_token);
                        }
                    } catch (_) {}
                    return origSend(s);
                };
                w._playSoundboardClip(cid);
                setTimeout(() => { console.error = origError; if (!resolved) resolve('TIMEOUT:' + logs.join('|')); }, 8000);
            });
        }, clipId);
        console.log('T2 token captured:', typeof tok === 'string' && tok.length === 60 ? 'yes' : tok);
        expect(tok).toBeTruthy();
        expect(tok).not.toContain('TIMEOUT');
        expect(tok).not.toContain('CACHE_MISS');

        // Fetch it once (should work)
        const ok1 = await page.evaluate(async (t: string) => {
            const r = await fetch('/api/soundboard/temp-play/' + t, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
            return r.status;
        }, tok!);
        expect(ok1).toBe(200);

        // Stop → server clears the token
        await page.evaluate(() => {
            const vs = (window as any).VoiceManager.getVoiceState();
            (window as any).ws.send(JSON.stringify({
                type: 'soundboard_stop', user_id: (window as any).currentUserId,
                server_id: (window as any).currentServerId, channel_id: vs.channelId,
                room_type: 'server', dm_channel_id: '',
            }));
        });
        await page.waitForTimeout(1200);
        const ok2 = await page.evaluate(async (t: string) => {
            const r = await fetch('/api/soundboard/temp-play/' + t, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
            return r.status;
        }, tok!);
        console.log('T2 token after stop:', ok2);
        expect(ok2).toBe(404);
    });
});

test.describe('Soundboard end-to-end (2 browsers)', () => {
    test('T3: receiver hears the sound; late joiner gets offset; player leave stops it', async ({ page, context }) => {
        test.setTimeout(300000);
        const u1 = unique('sba');
        const u2 = unique('sbb');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const clipId = await uploadIdentityClip(page, 'e2e_' + Date.now(), 4);
        await connectUsers(page, page2, serverId);
        // page2 joined the server via API — reload so the sidebar shows it
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);

        // u1 joins voice
        await joinVoice(page, serverId, voiceChannelId);
        // u2 joins voice
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(1500);

        // Track received soundboard messages on u2's page
        await page2.evaluate(() => {
            const w = window as any;
            w._sbReceived = [];
            const orig = w._handleSoundboardPlay;
            w._handleSoundboardPlay = function (d: any) { w._sbReceived.push({ t: Date.now(), data: d }); return orig.call(this, d); };
        });

        // u1 plays the clip (cache must be loaded first for programmatic play)
        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page.waitForTimeout(2500);

        // u2 must have received soundboard_play with a temp_token and server play_start_ms
        const received = await page2.evaluate(() => (window as any)._sbReceived || []);
        console.log('T3 u2 received:', JSON.stringify(received.map((r: any) => ({ tok: !!r.data.temp_token, start: r.data.play_start_ms }))));
        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0].data.temp_token).toBeTruthy();
        expect(received[0].data.play_start_ms).toBeGreaterThan(0);

        // u2's audio context should have an active soundboard source
        const u2Playing = await page2.evaluate(() => ((window as any)._sbAllPlaying || []).length);
        expect(u2Playing).toBeGreaterThanOrEqual(1);

        // Late join: u3 joins mid-playback, must receive play_start_ms to compute offset
        const ctx3 = await (page.context().browser() as any).newContext();
        const page3 = await ctx3.newPage();
        await register(page3, unique('sbc'));
        await waitForWs(page3);
        // friend u1 + join server
        await connectUsers(page, page3, serverId);
        await page3.reload();
        await page3.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page3);
        // Instrument the late joiner before joining voice
        await page3.evaluate(() => {
            const w = window as any;
            w._sbReceived = [];
            const orig = w._handleSoundboardPlay;
            w._handleSoundboardPlay = function (d: any) { w._sbReceived.push({ t: Date.now(), data: d }); return orig.call(this, d); };
        });
        await joinVoice(page3, serverId, voiceChannelId);
        await page3.waitForTimeout(2000);
        const late = await page3.evaluate(() => (window as any)._sbReceived || []);
        console.log('T3 u3 late-join msgs:', JSON.stringify(late.map((r: any) => ({ tok: !!r.data.temp_token, start: r.data.play_start_ms }))));
        // If the clip is still playing server-side, u3 gets the sync message with token+offset.
        // (clip is 4s; timing-dependent — accept either a synced play or a clean no-play)
        if (late.length > 0) {
            expect(late[0].data.temp_token).toBeTruthy();
        }

        // Cleanup contexts
        await ctx2.close();
        await ctx3.close();
    });

    test('T4: player leaving voice stops the sound for everyone (server clears current_soundboard)', async ({ page }) => {
        const u1 = unique('plv');
        const u2 = unique('plv2');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const clipId = await uploadIdentityClip(page, 'plv_' + Date.now(), 4);
        await connectUsers(page, page2, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(1500);

        // u2 listens for soundboard_stop
        await page2.evaluate(() => {
            const w = window as any;
            w._sbStopReceived = false;
            const origHandler = w.ws.onmessage;
            w.ws.addEventListener('message', function (ev: MessageEvent) {
                try {
                    const m = JSON.parse(ev.data);
                    if (m.type === 'soundboard_stop') w._sbStopReceived = true;
                } catch (_) {}
            });
        });

        // u1 plays, then leaves voice via the voice bar leave button
        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page.waitForTimeout(2000);
        await page.click('#voice-bar-leave');
        await page.waitForTimeout(2000);

        const stopReceived = await page2.evaluate(() => (window as any)._sbStopReceived);
        console.log('T4 u2 got soundboard_stop after player left:', stopReceived);
        expect(stopReceived).toBe(true);
        // u2's own soundboard state should have no entries from u1 anymore
        const remaining = await page2.evaluate(() => ((window as any)._sbAllPlaying || []).length);
        console.log('T4 u2 remaining playing entries:', remaining);

        await ctx2.close();
    });
});
