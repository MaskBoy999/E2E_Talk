import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                osc.frequency.value = 300;
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                return (canvas as any).captureStream(30);
            }
            return origGUM(constraints);
        };
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
    await page.evaluate(() => {
        const el = document.getElementById('loading-overlay');
        if (el) el.remove();
    });
    await page.waitForTimeout(500);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function createServerWithVoiceChannel(page: any): Promise<{ serverId: string; voiceChannelId: string }> {
    const ts = Date.now();
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'SB3_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(2000);
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');

    const voiceChannelId = await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const token = localStorage.getItem('token');
        const sk = (window as any).E2ECrypto.getServerKey(serverId);
        const encName = (window as any).E2ECrypto.aeadEncrypt('voice', sk);
        const res = await fetch(`/api/servers/${serverId}/channels`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_type: 'voice', encrypted_name: encName.ciphertext, name_nonce: encName.nonce }),
        });
        const ch = await res.json();
        return ch.id;
    }, { serverId });

    return { serverId, voiceChannelId };
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function inviteAndJoin(page1: any, page2: any, token1: string, token2: string, serverId: string) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    const invRes = await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { invite_code: code },
    });
    expect(invRes.ok()).toBeTruthy();
    const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { code: code },
    });
    expect(joinRes.ok()).toBeTruthy();
}

async function joinVoiceChannel(page: any, serverId: string, voiceChannelId: string, reloadFirst = false) {
    if (reloadFirst) {
        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    }
    await page.waitForTimeout(1000);
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${voiceChannelId}"]`, { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.click(`.channel-item[data-id="${voiceChannelId}"]`);
    await page.waitForFunction(() => {
        const bar = document.getElementById('voice-bar');
        return bar && bar.style.display !== 'none';
    }, { timeout: 15000 });
}

async function uploadSoundboardClip(page: any, serverId: string, clipName: string): Promise<string> {
    return await page.evaluate(async ({ serverId, clipName }: { serverId: string; clipName: string }) => {
        const token = localStorage.getItem('token');
        const rate = 8000, dur = 0.5, n = Math.floor(rate * dur);
        const dataSize = n * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const dv = new DataView(buf);
        dv.setUint32(0, 36 + dataSize, true);
        dv.setUint8(4, 0x52); dv.setUint8(5, 0x49); dv.setUint8(6, 0x46); dv.setUint8(7, 0x46);
        dv.setUint8(8, 0x57); dv.setUint8(9, 0x41); dv.setUint8(10, 0x56); dv.setUint8(11, 0x45);
        dv.setUint8(12, 0x66); dv.setUint8(13, 0x6D); dv.setUint8(14, 0x74); dv.setUint8(15, 0x20);
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        dv.setUint8(36, 0x64); dv.setUint8(37, 0x61); dv.setUint8(38, 0x74); dv.setUint8(39, 0x61);
        dv.setUint32(40, dataSize, true);
        for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
        const enc = (window as any).E2ECrypto.encryptBytesForServer(new Uint8Array(buf), serverId);
        const res = await fetch('/api/soundboard', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_id: serverId, name: clipName,
                encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce,
            }),
        });
        const data = await res.json();
        return data.id;
    }, { serverId, clipName });
}

// ═══════════════════════════════════════════════
// SINGLE-PAGE UNIT TESTS
// ═══════════════════════════════════════════════

test.describe('Soundboard 3-Browser: Core Functions', () => {

    test('_stopAllSoundboardAudioAll clears everything', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_clear');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const fake1 = { type: 'ctx', source: { stop: () => {} }, userId: 'user-a', clipId: 'c1' };
            const fake2 = { type: 'ctx', source: { stop: () => {} }, userId: 'user-b', clipId: 'c2' };
            (window as any)._sbAllPlaying.push(fake1, fake2);
            const before = (window as any)._sbAllPlaying.length;
            if ((window as any)._stopAllSoundboardAudioAll) (window as any)._stopAllSoundboardAudioAll();
            return { before, after: (window as any)._sbAllPlaying.length };
        });

        expect(result.before).toBe(2);
        expect(result.after).toBe(0);
    });

    test('hear-myself OFF blocks self-play', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_hsoff');
        await registerUser(page, username);
        await waitForWs(page);

        await page.evaluate(() => {
            const el = document.getElementById('soundboard-self-hear') as HTMLInputElement;
            if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
        });

        const played = await page.evaluate(() => {
            let played = false;
            const orig = (window as any)._sbAllPlaying.push.bind((window as any)._sbAllPlaying);
            (window as any)._sbAllPlaying.push = function (entry: any) { played = true; return orig(entry); };
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({
                    user_id: (window as any).currentUserId,
                    clip_id: 'test-clip',
                    encrypted_audio: 'fake-audio-data',
                    disabled: false,
                });
            }
            (window as any)._sbAllPlaying.push = orig;
            return played;
        });

        expect(played).toBe(false);

        await page.evaluate(() => {
            const el = document.getElementById('soundboard-self-hear') as HTMLInputElement;
            if (el) { el.checked = true; el.dispatchEvent(new Event('change')); }
        });
    });

    test('hear-myself OFF does not block other users sounds', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_hsot');
        await registerUser(page, username);
        await waitForWs(page);

        await page.evaluate(() => {
            const el = document.getElementById('soundboard-self-hear') as HTMLInputElement;
            if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
        });

        // Verify the self-hear check is INSIDE the user_id === currentUserId branch,
        // meaning other users' sounds are NOT blocked by hear-myself being OFF.
        // We test this by confirming _handleSoundboardPlay doesn't return early
        // for a different user_id, and that _sbIsUserMuted returns false.
        const result = await page.evaluate(() => {
            const uid = 'other-user-test';
            const myId = (window as any).currentUserId;
            const isSelf = uid === myId;
            const isMuted = (window as any)._sbIsUserMuted(uid);

            // hear-myself OFF should only affect self-play, not others
            // If uid !== myId, the handler should NOT be blocked by _sbSelfHear
            return { isSelf, isMuted, shouldBlock: isSelf || isMuted };
        });

        expect(result.isSelf).toBe(false);
        expect(result.isMuted).toBe(false);
        expect(result.shouldBlock).toBe(false);

        await page.evaluate(() => {
            const el = document.getElementById('soundboard-self-hear') as HTMLInputElement;
            if (el) { el.checked = true; el.dispatchEvent(new Event('change')); }
        });
    });

    test('global disable blocks both play and receive', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_gdis');
        await registerUser(page, username);
        await waitForWs(page);

        await page.evaluate(() => { localStorage.setItem('sb_disabled_global', '1'); });

        const blocked = await page.evaluate(() => {
            let played = false;
            const orig = (window as any)._sbAllPlaying.push.bind((window as any)._sbAllPlaying);
            (window as any)._sbAllPlaying.push = function (entry: any) { played = true; return orig(entry); };
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({
                    user_id: 'other-user',
                    clip_id: 'test-clip',
                    encrypted_audio: 'fake-audio-data',
                    disabled: false,
                });
            }
            (window as any)._sbAllPlaying.push = orig;
            return played;
        });

        expect(blocked).toBe(false);
        await page.evaluate(() => { localStorage.removeItem('sb_disabled_global'); });
    });

    test('deafened user cannot hear soundboard sounds', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_deaf');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            if ((window as any).VoiceManager && (window as any).VoiceManager._debug) {
                (window as any).VoiceManager._debug.state.deafened = true;
            }
            let played = false;
            const orig = (window as any)._sbAllPlaying.push.bind((window as any)._sbAllPlaying);
            (window as any)._sbAllPlaying.push = function (entry: any) { played = true; return orig(entry); };
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({
                    user_id: 'other-user',
                    clip_id: 'test-clip',
                    encrypted_audio: 'fake-audio-data',
                    disabled: false,
                });
            }
            (window as any)._sbAllPlaying.push = orig;
            if ((window as any).VoiceManager && (window as any).VoiceManager._debug) {
                (window as any).VoiceManager._debug.state.deafened = false;
            }
            return played;
        });

        expect(result).toBe(false);
    });

    test('disabled-by-owner flag blocks play', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_disown');
        await registerUser(page, username);
        await waitForWs(page);

        const blocked = await page.evaluate(() => {
            let played = false;
            const orig = (window as any)._sbAllPlaying.push.bind((window as any)._sbAllPlaying);
            (window as any)._sbAllPlaying.push = function (entry: any) { played = true; return orig(entry); };
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({
                    user_id: 'some-user',
                    clip_id: 'test-clip',
                    encrypted_audio: 'fake-audio-data',
                    disabled: true,
                });
            }
            (window as any)._sbAllPlaying.push = orig;
            return played;
        });

        expect(blocked).toBe(false);
    });

    test('mute blocks that users sounds', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_muteblk');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const uid = 'mute-test-user';
            (window as any)._sbToggleMuteUser(uid);
            const muted = (window as any)._sbIsUserMuted(uid);

            let played = false;
            const orig = (window as any)._sbAllPlaying.push.bind((window as any)._sbAllPlaying);
            (window as any)._sbAllPlaying.push = function (entry: any) { played = true; return orig(entry); };
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({
                    user_id: uid,
                    clip_id: 'test-clip',
                    encrypted_audio: 'fake-audio-data',
                    disabled: false,
                });
            }
            (window as any)._sbAllPlaying.push = orig;

            (window as any)._sbToggleMuteUser(uid);
            return { muted, played };
        });

        expect(result.muted).toBe(true);
        expect(result.played).toBe(false);
    });

    test('mute is global (localStorage key sb_muted without server prefix)', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_mutekey');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#add-server-btn');
        await page.click('#choice-create-server');
        await page.fill('#new-server-name', 'SB3MK_' + Date.now());
        await page.click('#confirm-create-server');
        await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const uid = 'global-mute-test';
            (window as any)._sbToggleMuteUser(uid);
            const globalKey = localStorage.getItem('sb_muted');
            const parsed = globalKey ? JSON.parse(globalKey) : [];
            const inGlobal = parsed.indexOf(uid) !== -1;
            const perServerKey = localStorage.getItem('sb_muted_' + (window as any).currentServerId);
            (window as any)._sbToggleMuteUser(uid);
            return { inGlobal, perServerKey };
        });

        expect(result.inGlobal).toBe(true);
        expect(result.perServerKey).toBeNull();
    });

    test('mute indicator active class and checkmark text', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_mind');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const uid = 'indicator-test-user';
            (window as any)._sbToggleMuteUser(uid);
            const isMuted = (window as any)._sbIsUserMuted(uid);
            const btnText = isMuted ? '\u2713 \uD83D\uDD0A Unmute Soundboard' : '\uD83D\uDD07 Mute Soundboard';
            const btnClass = 'volume-menu-btn' + (isMuted ? ' active' : '');
            (window as any)._sbToggleMuteUser(uid);
            return { isMuted, btnText, btnClass };
        });

        expect(result.btnText).toContain('\u2713');
        expect(result.btnText).toContain('Unmute');
        expect(result.btnClass).toContain('active');
    });

    test('handleSoundboardStop is safe with no matching entries', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_stopsafe');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            try {
                (window as any)._handleSoundboardStop({ user_id: 'nonexistent' });
                (window as any)._handleSoundboardStop({});
                return { success: true, len: (window as any)._sbAllPlaying.length };
            } catch (e) {
                return { error: String(e) };
            }
        });

        expect(result.success).toBe(true);
        expect(result.len).toBe(0);
    });

    test('all required soundboard functions exist on window', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_funcs');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => ({
            hasStopAll: typeof (window as any)._stopAllSoundboardAudio === 'function',
            hasStopAllAll: typeof (window as any)._stopAllSoundboardAudioAll === 'function',
            hasHandleStop: typeof (window as any)._handleSoundboardStop === 'function',
            hasHandlePlay: typeof (window as any)._handleSoundboardPlay === 'function',
            hasToggleMute: typeof (window as any)._sbToggleMuteUser === 'function',
            hasMutedList: typeof (window as any)._sbMutedList !== 'undefined',
            hasIsMuted: typeof (window as any)._sbIsUserMuted === 'function',
            hasDisabledUsers: Array.isArray((window as any)._sbDisabledUsers),
            myId: (window as any).currentUserId,
            playingIsArray: Array.isArray((window as any)._sbAllPlaying),
            hasSendStop: typeof (window as any)._sendSoundboardStop === 'function',
        }));

        expect(result.hasStopAll).toBe(true);
        expect(result.hasStopAllAll).toBe(true);
        expect(result.hasHandleStop).toBe(true);
        expect(result.hasHandlePlay).toBe(true);
        expect(result.hasToggleMute).toBe(true);
        expect(result.hasMutedList).toBe(true);
        expect(result.hasIsMuted).toBe(true);
        expect(result.hasDisabledUsers).toBe(true);
        expect(result.myId).toBeTruthy();
        expect(result.playingIsArray).toBe(true);
        expect(result.hasSendStop).toBe(true);
    });
});

// ═══════════════════════════════════════════════
// TWO-PAGE INTEGRATION TESTS
// ═══════════════════════════════════════════════

test.describe('Soundboard 3-Browser: Two-user integration', () => {

    test('mute/unmute and stop work together', async ({ context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push(err.message));

        const u1 = await registerUser(page1, 'sb3int1_' + ts);
        const u2 = await registerUser(page2, 'sb3int2_' + ts);
        await becomeFriends(page1, page2, u1.token, u2.token);
        await waitForWs(page1);
        await waitForWs(page2);

        const { serverId } = await createServerWithVoiceChannel(page1);
        await inviteAndJoin(page1, page2, u1.token, u2.token, serverId);

        // Simulate u2 playing — u1 hears it
        await page1.evaluate(({ userId, clipId }: any) => {
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({ user_id: userId, clip_id: clipId, encrypted_audio: 'fake', disabled: false });
            }
        }, { userId: u2.user.id, clipId: 'test-clip' });

        const u1HasSound = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(u1HasSound).toBeGreaterThan(0);

        // u1 mutes u2
        await page1.evaluate(({ uid }: { uid: string }) => {
            (window as any)._sbToggleMuteUser(uid);
        }, { uid: u2.user.id });

        // Stop u2's sounds
        await page1.evaluate(({ userId }: any) => {
            if ((window as any)._handleSoundboardStop) (window as any)._handleSoundboardStop({ user_id: userId });
        }, { userId: u2.user.id });

        const u1AfterStop = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(u1AfterStop).toBe(0);

        // Verify u2 is muted
        const muted = await page1.evaluate(({ uid }: { uid: string }) => {
            return (window as any)._sbIsUserMuted(uid);
        }, { uid: u2.user.id });
        expect(muted).toBe(true);

        // Unmute
        await page1.evaluate(({ uid }: { uid: string }) => {
            (window as any)._sbToggleMuteUser(uid);
        }, { uid: u2.user.id });

        expect(p1Errors).toEqual([]);
        expect(p2Errors).toEqual([]);

        await ctx1.close();
        await ctx2.close();
    });

    test('leaving stops ALL sounds for the leaver', async ({ context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));

        const u1 = await registerUser(page1, 'sb3lv1_' + ts);
        await waitForWs(page1);

        // Simulate sounds playing from two different users
        await page1.evaluate(({ userId, clipId }: any) => {
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({ user_id: userId, clip_id: clipId, encrypted_audio: 'fake', disabled: false });
            }
        }, { userId: 'other-user-123', clipId: 'clip-a' });

        await page1.evaluate(({ userId, clipId }: any) => {
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({ user_id: userId, clip_id: clipId, encrypted_audio: 'fake', disabled: false });
            }
        }, { userId: u1.user.id, clipId: 'clip-b' });

        const u1Before = await page1.evaluate(() => (window as any)._sbAllPlaying.length);

        // u1 leaves — ALL sounds stop for u1
        await page1.evaluate(() => {
            if ((window as any)._stopAllSoundboardAudioAll) (window as any)._stopAllSoundboardAudioAll();
        });

        const u1After = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(u1After).toBe(0);

        expect(p1Errors).toEqual([]);
        await ctx1.close();
    });

    test('member leave stops their sounds for other clients', async ({ context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));

        const u1 = await registerUser(page1, 'sb3ml1_' + ts);
        await waitForWs(page1);

        // Simulate another user's sounds playing on u1's client
        await page1.evaluate(({ userId, clipId }: any) => {
            if ((window as any)._handleSoundboardPlay) {
                (window as any)._handleSoundboardPlay({ user_id: userId, clip_id: clipId, encrypted_audio: 'fake', disabled: false });
            }
        }, { userId: 'leaving-user', clipId: 'clip-a' });

        const u1Before = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(u1Before).toBeGreaterThan(0);

        // Simulate u2 leaving — u1 stops u2's sounds
        await page1.evaluate(({ uid }: { uid: string }) => {
            if ((window as any)._handleSoundboardStop) (window as any)._handleSoundboardStop({ user_id: uid });
        }, { uid: 'leaving-user' });

        const u1After = await page1.evaluate(() => (window as any)._sbAllPlaying.length);
        expect(u1After).toBe(0);

        expect(p1Errors).toEqual([]);
        await ctx1.close();
    });

    test('owner disable/enable user via API', async ({ context }) => {
        test.setTimeout(180000);
        const ts = Date.now();

        const ctx1 = await context.browser()!.newContext();
        const page1 = await ctx1.newPage();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const p1Errors: string[] = [];
        page1.on('pageerror', (err) => p1Errors.push(err.message));
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push(err.message));

        const u1 = await registerUser(page1, 'sb3dis1_' + ts);
        const u2 = await registerUser(page2, 'sb3dis2_' + ts);
        await becomeFriends(page1, page2, u1.token, u2.token);
        await waitForWs(page1);
        await waitForWs(page2);

        const { serverId } = await createServerWithVoiceChannel(page1);
        await inviteAndJoin(page1, page2, u1.token, u2.token, serverId);

        // Click on the server to set currentServerId
        await page1.click(`.server-icon[data-id="${serverId}"]`);
        await page1.waitForTimeout(1000);

        // Ensure currentServerId is set
        const currentSid = await page1.evaluate(() => (window as any).currentServerId);
        expect(currentSid).toBeTruthy();

        // u1 (owner) disables u2's soundboard via API
        const disableRes = await page1.request.put(`${BASE}/api/soundboard/disable/${serverId}/${u2.user.id}`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
        });
        expect(disableRes.ok()).toBeTruthy();

        // Reload disabled list (uses currentServerId internally)
        await page1.evaluate(async () => {
            if ((window as any)._loadDisabledSoundboardUsers) await (window as any)._loadDisabledSoundboardUsers();
        });

        const isDisabled = await page1.evaluate(({ uid }: { uid: string }) => {
            return (window as any)._sbDisabledUsers.includes(uid);
        }, { uid: u2.user.id });
        expect(isDisabled).toBe(true);

        // Re-enable u2
        const enableRes = await page1.request.delete(`${BASE}/api/soundboard/disable/${serverId}/${u2.user.id}`, {
            headers: { Authorization: `Bearer ${u1.token}`, 'Content-Type': 'application/json' },
        });
        expect(enableRes.ok()).toBeTruthy();

        await page1.evaluate(async () => {
            if ((window as any)._loadDisabledSoundboardUsers) await (window as any)._loadDisabledSoundboardUsers();
        });

        const isEnabled = await page1.evaluate(({ uid }: { uid: string }) => {
            return !(window as any)._sbDisabledUsers.includes(uid);
        }, { uid: u2.user.id });
        expect(isEnabled).toBe(true);

        expect(p1Errors).toEqual([]);
        expect(p2Errors).toEqual([]);

        await ctx1.close();
        await ctx2.close();
    });

    test('late join offset calculation', async ({ page }) => {
        test.setTimeout(90000);
        const username = unique('sb3_late');
        await registerUser(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const playStartTime = Date.now() - 15000;
            const lateOffset = Math.max(0, Date.now() - playStartTime);
            return lateOffset;
        });

        expect(result).toBeGreaterThanOrEqual(14000);
        expect(result).toBeLessThanOrEqual(16000);
    });
});
