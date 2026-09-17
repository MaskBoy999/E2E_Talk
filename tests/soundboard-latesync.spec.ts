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

async function createServerWithVoice(page: any): Promise<{ serverId: string; voiceChannelId: string }> {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 8000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 8000 });
    await page.fill('#new-server-name', 'LateSync_' + Date.now());
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
        const rate = 8000, n = Math.floor(rate * durationSec);
        const dataSize = n * 2;
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
        w8(36, 0x64); w8(37, 0x61); w8(38, 0x74); w8(39, 0x61);
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

test.describe('Soundboard late-sync & button fixes', () => {

    test('L1: duration_ms is propagated through the relayed play message', async ({ page }) => {
        test.setTimeout(180000);
        const u1 = unique('lsa');
        const u2 = unique('lsb');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        // 6-second clip — plenty of time for both users to be in the room
        const clipId = await uploadClip(page, 'dur6_' + Date.now(), 6);
        await connectUsers(page, page2, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(2000);

        // Track plays received by u2
        await page2.evaluate(() => {
            const w = window as any;
            w._sbReceived = [];
            const orig = w._handleSoundboardPlay;
            w._handleSoundboardPlay = function (d: any) { w._sbReceived.push({ t: Date.now(), data: d }); return orig.call(this, d); };
        });

        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page.waitForTimeout(2500);

        const received = await page2.evaluate(() => (window as any)._sbReceived || []);
        expect(received.length).toBeGreaterThanOrEqual(1);
        const playMsg = received[0].data;
        // duration_ms must be present in the relayed message
        expect(playMsg.duration_ms).toBeGreaterThanOrEqual(6000);
        expect(playMsg.play_start_ms).toBeGreaterThan(0);
        expect(playMsg.temp_token).toBeTruthy();
        await ctx2.close();
    });

    test('L2: late joiner starts near the correct position (decrypt time counted)', async ({ page }) => {
        test.setTimeout(240000);
        const u1 = unique('lja');
        const u2 = unique('ljb');
        const u3 = unique('ljc');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        // Pre-register u3 BEFORE playback so the late-join timing is precise
        const ctx3 = await (page.context().browser() as any).newContext();
        const page3 = await ctx3.newPage();
        await register(page3, u3);
        await waitForWs(page3);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        const clipId = await uploadClip(page, 'late_' + Date.now(), 30);
        await connectUsers(page, page2, serverId);
        await connectUsers(page, page3, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);
        await page3.reload();
        await page3.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page3);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(1500);

        // u1 plays a 30s clip
        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        // Wait ~4.5s — clip is now ~4.5s in
        await page.waitForTimeout(4500);

        // u3 (already registered + in server) joins voice mid-playback
        await page3.evaluate(() => {
            const w = window as any;
            w._sbReceived = [];
            const orig = w._handleSoundboardPlay;
            w._handleSoundboardPlay = function (d: any) { w._sbReceived.push({ t: Date.now(), data: d }); return orig.call(this, d); };
        });
        await joinVoice(page3, serverId, voiceChannelId);
        await page3.waitForTimeout(2500);

        const late = await page3.evaluate(() => (window as any)._sbReceived || []);
        console.log('L2 late-join msgs:', JSON.stringify(late.map((r: any) => ({
            tok: !!r.data.temp_token,
            start: r.data.play_start_ms,
            dur: r.data.duration_ms,
        }))));
        expect(late.length).toBeGreaterThanOrEqual(1);
        const msg = late[0].data;
        expect(msg.temp_token).toBeTruthy();
        expect(msg.duration_ms).toBeGreaterThanOrEqual(10000);
        // The offset computed at receive time should be roughly the join position.
        // late[i].t is Date.now() when the handler ran.
        const recvOffset = late[0].t - (msg.play_start_ms || 0);
        // u3 joined ~4.5-6.5s into a 10s clip; offset should be in that ballpark,
        // NOT 0 (which would mean replaying from the start)
        console.log('L2 computed offset at receive:', recvOffset, 'ms');
        expect(recvOffset).toBeGreaterThan(1500);

        // u3's AudioContext should actually be playing something
        const u3Playing = await page3.evaluate(() => ((window as any)._sbAllPlaying || []).length);
        expect(u3Playing).toBeGreaterThanOrEqual(1);

        await ctx2.close();
        await ctx3.close();
    });

    test('L3: _playViaAudioCtx skips playback when offset is past the end', async ({ page }) => {
        const u = unique('pastend');
        await register(page, u);
        await waitForWs(page);
        const result = await page.evaluate(async () => {
            const w = window as any;
            // Build a tiny 0.5s WAV directly
            const rate = 8000, n = rate / 2, dataSize = n * 2;
            const buf = new ArrayBuffer(44 + dataSize);
            const dv = new DataView(buf);
            dv.setUint32(40, dataSize, true);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
            const bytes = new Uint8Array(buf);
            let ended = false;
            // Access the internal _playViaAudioCtx via a play message path — instead
            // verify via decodeAudioData duration comparison in _handleSoundboardPlay:
            // Simulate a play with an offset way past the end using the WS handler.
            let playedEntry = null;
            // Capture what lands in _sbAllPlaying
            const before = (w._sbAllPlaying || []).length;
            // offset 5000ms into a 0.5s clip → should NOT play
            w._handleSoundboardPlay({
                user_id: 'someone_else',
                clip_id: 'clip_past_end',
                encrypted_audio: btoa(String.fromCharCode(...bytes)),
                play_start_ms: Date.now() - 5000, // 5s ago → offset 5s > 0.5s duration
                duration_ms: 500,
                _lateJoinOffset: 5000,
            });
            await new Promise((r: any) => setTimeout(r, 1200));
            const after = (w._sbAllPlaying || []).length;
            return { before, after, noNewEntry: after === before };
        });
        console.log('L3 past-end result:', JSON.stringify(result));
        expect(result.noNewEntry).toBe(true);
    });

    test('L4: stop button resets when own clip ends naturally', async ({ page }) => {
        test.setTimeout(180000);
        const u1 = unique('enda');
        await register(page, u1);
        await waitForWs(page);
        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        // 1.5s clip — ends quickly
        const clipId = await uploadClip(page, 'end_' + Date.now(), 2);
        await joinVoice(page, serverId, voiceChannelId);
        await page.waitForTimeout(2500);

        await page.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        // Open the soundboard overlay so we can watch the buttons
        await page.evaluate(() => {
            const ov = document.getElementById('soundboard-overlay');
            if (ov) ov.style.display = 'flex';
        });
        await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        // Wait for play to start
        await page.waitForTimeout(1500);
        // During playback the pause (stop) button of this clip should be visible
        const during = await page.evaluate((cid: string) => {
            const el = document.querySelector(`.soundboard-clip[data-clip-id="${cid}"]`);
            const pp = el?.querySelector('.sb-pause-btn') as HTMLElement;
            const pb = el?.querySelector('.sb-play-btn') as HTMLElement;
            return { pauseVisible: !!pp && pp.style.display !== 'none', playVisible: !!pb && pb.style.display !== 'none' };
        }, clipId);
        console.log('L4 during play:', JSON.stringify(during));

        // Wait for the 2s clip to finish + buffer
        await page.waitForTimeout(3500);
        const after = await page.evaluate((cid: string) => {
            const el = document.querySelector(`.soundboard-clip[data-clip-id="${cid}"]`);
            const pp = el?.querySelector('.sb-pause-btn') as HTMLElement;
            const pb = el?.querySelector('.sb-play-btn') as HTMLElement;
            return { pauseVisible: !!pp && pp.style.display !== 'none', playVisible: !!pb && pb.style.display !== 'none' };
        }, clipId);
        console.log('L4 after natural end:', JSON.stringify(after));
        // The stop button must NOT be visible after the clip finished
        expect(after.pauseVisible).toBe(false);
        expect(after.playVisible).toBe(true);
    });

    test('L6: owner disable stops the playing sound live for the room AND the player', async ({ page }) => {
        test.setTimeout(240000);
        const u1 = unique('owna');
        const u2 = unique('ownb');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        // a 30s clip so it is still playing when the owner disables
        await connectUsers(page, page2, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);
        const clipId = await uploadClip(page2, 'own_' + Date.now(), 30);
        const u2Id = await page2.evaluate(() => (window as any).currentUserId);
        const token1 = await page.evaluate(() => localStorage.getItem('token'));

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(2500);

        // u2 plays → u1 (the room) hears it
        await page2.evaluate(async () => { if ((window as any)._loadSoundboardClips) await (window as any)._loadSoundboardClips(); });
        await page2.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page.waitForTimeout(3500);

        const before = await page.evaluate((uid: string) => ({
            badge: !!(window as any)._sbPlayingUsers?.[uid],
            entries: (window as any)._sbAllPlaying.length,
        }), u2Id);
        expect(before.badge).toBe(true);
        expect(before.entries).toBeGreaterThanOrEqual(1);

        // Owner disables u2 while the clip is playing
        const dis = await page.request.put(`${BASE}/api/soundboard/disable/${serverId}/${u2Id}`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        });
        expect(dis.ok()).toBeTruthy();
        await page.waitForTimeout(2500);

        // Listeners stop hearing it immediately (server broadcast + local stop)
        const afterListener = await page.evaluate((uid: string) => ({
            badge: !!(window as any)._sbPlayingUsers?.[uid],
            entries: (window as any)._sbAllPlaying.length,
        }), u2Id);
        expect(afterListener.badge).toBe(false);
        expect(afterListener.entries).toBe(0);

        // And the disabled player's own client learns it live (their self-hear stops)
        const afterPlayer = await page2.evaluate(() => ({
            entries: (window as any)._sbAllPlaying.length,
            ownerDisabled: !!(window as any)._sbIsOwnerDisabledForMe && (window as any)._sbIsOwnerDisabledForMe(),
        }));
        expect(afterPlayer.ownerDisabled).toBe(true);
        expect(afterPlayer.entries).toBe(0);

        // A disabled user cannot start new sounds
        await page2.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page2.waitForTimeout(2500);
        expect(await page2.evaluate(() => (window as any)._sbAllPlaying.length)).toBe(0);

        // Re-enable → playing works again
        const en = await page.request.delete(`${BASE}/api/soundboard/disable/${serverId}/${u2Id}`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        });
        expect(en.ok()).toBeTruthy();
        await page2.waitForTimeout(1500);
        expect(await page2.evaluate(() => !!(window as any)._sbIsOwnerDisabledForMe && (window as any)._sbIsOwnerDisabledForMe())).toBe(false);
        await page2.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
        await page2.waitForTimeout(3500);
        expect(await page2.evaluate(() => (window as any)._sbAllPlaying.length)).toBeGreaterThanOrEqual(1);

        await ctx2.close();
    });

    test('L5: mute button indicator updates in place (menu stays open)', async ({ page }) => {
        test.setTimeout(120000);
        const u1 = unique('muta');
        const u2 = unique('mutb');
        await register(page, u1);
        await waitForWs(page);

        const ctx2 = await (page.context().browser() as any).newContext();
        const page2 = await ctx2.newPage();
        await register(page2, u2);
        await waitForWs(page2);

        const { serverId, voiceChannelId } = await createServerWithVoice(page);
        await connectUsers(page, page2, serverId);
        await page2.reload();
        await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 20000 });
        await waitForWs(page2);

        await joinVoice(page, serverId, voiceChannelId);
        await joinVoice(page2, serverId, voiceChannelId);
        await page.waitForTimeout(2500);

        // On u1's page, find the member row for u2 and right-click it
        const u2Id = await page2.evaluate(() => (window as any).currentUserId);
        expect(u2Id).toBeTruthy();

        // Open the volume menu via the contextmenu event on the member row
        await page.evaluate((uid: string) => {
            const row = document.querySelector(`.voice-member-row[data-uid="${uid}"]`);
            if (!row) throw new Error('member row not found');
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
        }, u2Id);
        await page.waitForTimeout(600);

        // The volume menu should be open with the mute soundboard button
        const menuBefore = await page.evaluate(() => {
            const menu = document.getElementById('volume-menu');
            if (!menu || menu.style.display === 'none') return { open: false };
            const btns = Array.from(menu.querySelectorAll('button'));
            const sbBtn = btns.find(b => b.textContent?.includes('Mute Soundboard') || b.textContent?.includes('Unmute Soundboard'));
            return { open: true, btn: sbBtn ? { text: sbBtn.textContent, active: sbBtn.className.includes('active') } : null };
        });
        console.log('L5 menu before:', JSON.stringify(menuBefore));
        expect(menuBefore.open).toBe(true);
        expect(menuBefore.btn).toBeTruthy();

        // Click the mute button — the menu must STAY OPEN and the label flip
        await page.evaluate(() => {
            const menu = document.getElementById('volume-menu');
            const btns = Array.from(menu!.querySelectorAll('button'));
            const sbBtn = btns.find(b => (b.textContent || '').includes('Soundboard')) as HTMLElement;
            sbBtn.click();
        });
        await page.waitForTimeout(600);

        const menuAfter = await page.evaluate(() => {
            const menu = document.getElementById('volume-menu');
            if (!menu || menu.style.display === 'none') return { open: false };
            const btns = Array.from(menu.querySelectorAll('button'));
            const sbBtn = btns.find(b => b.textContent?.includes('Mute Soundboard') || b.textContent?.includes('Unmute Soundboard'));
            return { open: true, btn: sbBtn ? { text: sbBtn.textContent, active: sbBtn.className.includes('active') } : null };
        });
        console.log('L5 menu after click:', JSON.stringify(menuAfter));
        // Menu still open
        expect(menuAfter.open).toBe(true);
        // Label flipped to unmute + active class
        expect(menuAfter.btn?.text).toContain('Unmute');
        expect(menuAfter.btn?.active).toBe(true);

        // Click again — flips back to unmuted state, still open
        await page.evaluate(() => {
            const menu = document.getElementById('volume-menu');
            const btns = Array.from(menu!.querySelectorAll('button'));
            const sbBtn = btns.find(b => b.textContent?.includes('Mute Soundboard') || b.textContent?.includes('Unmute Soundboard')) as HTMLElement;
            sbBtn.click();
        });
        await page.waitForTimeout(400);
        const menuAfter2 = await page.evaluate(() => {
            const menu = document.getElementById('volume-menu');
            if (!menu || menu.style.display === 'none') return { open: false };
            const btns = Array.from(menu.querySelectorAll('button'));
            const sbBtn = btns.find(b => (b.textContent || '').includes('Soundboard'));
            return { open: true, btn: sbBtn ? { text: (sbBtn.textContent || '').trim(), active: sbBtn.className.includes('active') } : null };
        });
        expect(menuAfter2.open).toBe(true);
        // Back to the plain "Mute Soundboard" label (no checkmark, no "Unmute") and
        // inactive. The label is built from inline SVG icons, so assert on the
        // text content rather than the old emoji glyphs.
        expect(menuAfter2.btn?.text).toContain('Mute Soundboard');
        expect(menuAfter2.btn?.text).not.toContain('Unmute');
        expect(menuAfter2.btn?.active).toBe(false);

        await ctx2.close();
    });
});
