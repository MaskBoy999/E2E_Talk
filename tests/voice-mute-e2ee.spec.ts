import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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
                (window as any).__mockOsc = osc;
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                const stream = (canvas as any).captureStream(30);
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return stream;
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            const vStream = await (navigator.mediaDevices as any).getUserMedia({ video: true });
            const aStream = await (navigator.mediaDevices as any).getUserMedia({ audio: true });
            const out = new MediaStream();
            vStream.getTracks().forEach((t: any) => out.addTrack(t));
            aStream.getTracks().forEach((t: any) => out.addTrack(t));
            return out;
        };
    });
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

async function waitForWs(page: any) {
    return await page.evaluate(() => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= 60) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    });
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    return { userData, dm };
}

async function openDm(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) {
            await conv.first().click().catch(() => {});
            await page.waitForTimeout(800);
            break;
        }
        await page.waitForTimeout(300);
    }
}

async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => (window as any).VoiceManager._debug.state.connected, undefined, { timeout: 20000 });
}

// Poll getPeerDiag until the predicate passes; returns the last diag array.
async function waitDiag(page: any, uid: string, pred: (d: any) => boolean, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
        last = await page.evaluate((bUid) => (window as any).VoiceManager.getPeerDiag(), uid);
        const d = last.find((x: any) => x.uid === uid);
        if (d && pred(d)) return last;
        await page.waitForTimeout(500);
    }
    return last;
}

test.describe('mute/unmute, E2EE persistence, unload placement, diag reasons', () => {
    test('3 mute/unmute cycles: ONE audio receiver, E2EE encrypt transform intact, media resumes', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'mte2_' + ts);
        const body1 = await registerUser(page, 'mte1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // A's mic must be flowing first (send audio transform on + packets).
        await waitDiag(page, body2.user.id, (d: any) =>
            d.senders.audio && d.senders.audio.tracks >= 1 && d.senders.audio.transform === true && d.senders.audio.packets > 0);

        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => (window as any).VoiceManager.toggleMute());
            await page.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === true, undefined, { timeout: 10000 });
            await page.waitForTimeout(600);
            await page.evaluate(() => (window as any).VoiceManager.toggleMute());
            await page.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === false, undefined, { timeout: 10000 });
            // After unmute, the mic restarts: wait for the encrypt transform on
            // the SAME sender and packets flowing again.
            const diag = await waitDiag(page, body2.user.id, (d: any) =>
                d.senders.audio && d.senders.audio.tracks >= 1 && d.senders.audio.transform === true && d.senders.audio.packets > 0);
            const dA = diag.find((x: any) => x.uid === body2.user.id)!;
            expect(dA.senders.audio.transform).toBe(true);
            expect(dA.senders.audio.packets).toBeGreaterThan(0);
        }

        // B is the receiver of A's mic: exactly ONE audio receiver after all
        // the mute/unmute cycles (the old code added one per cycle → ×3).
        const diagB = await waitDiag(page2, body1.user.id, (d: any) =>
            d.receivers.audio && d.receivers.audio.tracks >= 1 && d.receivers.audio.packets > 0);
        const dB = diagB.find((x: any) => x.uid === body1.user.id)!;
        expect(dB.receivers.audio.tracks).toBe(1);
        expect(dB.receivers.audio.transform).toBe(true);

        // A's own side: B's mic to A is still one receiver with the decrypt transform.
        const diagA = await waitDiag(page, body2.user.id, (d: any) => d.receivers.audio && d.receivers.audio.tracks >= 1);
        const dA2 = diagA.find((x: any) => x.uid === body2.user.id)!;
        expect(dA2.receivers.audio.tracks).toBe(1);
        expect(dA2.receivers.audio.transform).toBe(true);

        await ctx2.close();
    });

    test('unload buttons sit inside their own tile with camera + screen both on', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'unl2_' + ts);
        const body1 = await registerUser(page, 'unl1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // B turns camera + screen on so A has two loaded feeds with Unload buttons.
        await page2.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page2.evaluate(() => (window as any).VoiceManager.toggleScreen());

        // Wait until A's panel has BOTH remote tiles (camera + screen) visible.
        await page.waitForFunction((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.remoteStreams[bUid] && s.remoteStreams[bUid].camera && s.remoteStreams[bUid].screen;
        }, body2.user.id, { timeout: 45000 });

        // Manual load is OFF (default) → feeds are loaded → Unload buttons exist.
        await page.waitForSelector('.dm-call-tile .voice-feed-unload-btn', { timeout: 20000 });

        const pos = await page.evaluate((bUid) => {
            const tiles = Array.from(document.querySelectorAll('.dm-call-tile[data-uid="' + bUid + '"] .remote-video-tile')) as HTMLElement[];
            const out: any[] = [];
            tiles.forEach((tile) => {
                const kind = tile.dataset.kind;
                const btn = tile.parentElement!.querySelector('.voice-feed-unload-btn[data-feed="' + bUid + ':' + kind + '"]') as HTMLElement | null;
                if (!btn) return;
                const tr = tile.getBoundingClientRect();
                const br = btn.getBoundingClientRect();
                out.push({
                    kind,
                    inside: br.left >= tr.left - 1 && br.right <= tr.right + 1 && br.top >= tr.top - 1 && br.bottom <= tr.bottom + 1,
                    btnRect: { l: Math.round(br.left), r: Math.round(br.right), t: Math.round(br.top), b: Math.round(br.bottom) },
                    tileRect: { l: Math.round(tr.left), r: Math.round(tr.right), t: Math.round(tr.top), b: Math.round(tr.bottom) },
                    btnVisible: getComputedStyle(btn).display !== 'none',
                });
            });
            return out;
        }, body2.user.id);
        console.log('UNLOAD POS:', JSON.stringify(pos));
        expect(pos.length).toBeGreaterThanOrEqual(2);
        const kinds = pos.map((p: any) => p.kind).sort();
        expect(kinds).toContain('camera');
        expect(kinds).toContain('screen');
        pos.forEach((p: any) => expect(p.inside).toBe(true));

        await ctx2.close();
    });

    test('diagnostics show the reason + fix for a black feed (0 packets, missing E2EE)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'rsn2_' + ts);
        const body1 = await registerUser(page, 'rsn1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // Both turn cameras on so A has a recv-video receiver to diagnose.
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page2.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await waitDiag(page, body2.user.id, (d: any) =>
            d.senders.video && d.senders.video.frames > 0 && d.receivers.video && d.receivers.video.frames > 0, 45000);

        // Simulate the user's real-world black-feed signature: recv video gets
        // 0 frames + 0 packets and its decrypt transform is missing, while
        // send video + audio keep flowing. Reproduce exactly the pasted diag.
        const armed = await page.evaluate((bUid) => {
            const s = (window as any).VoiceManager._debug.state;
            const pc = s.peers[bUid];
            if (!pc) return null;
            const vidRecv = pc.getReceivers().find((r: any) => r.track && r.track.kind === 'video');
            if (!vidRecv) return null;
            const audSend = pc.getSenders().find((s: any) => s.track && s.track.kind === 'audio');
            (window as any).__origGetStats2 = pc.getStats;
            (window as any).__origTransform2 = vidRecv.transform;
            (window as any).__origSendTransform2 = audSend ? audSend.transform : undefined;
            vidRecv.transform = null; // simulate a lost decrypt transform
            if (audSend) audSend.transform = null; // simulate mic sent without encryption
            pc.getStats = function () {
                return Promise.resolve([
                    { type: 'outbound-rtp', kind: 'audio', framesEncoded: 0, packetsSent: 653, packetsLost: 0, bytesSent: 57900 },
                    { type: 'outbound-rtp', kind: 'video', framesEncoded: 6900, packetsSent: 27357, packetsLost: 0, bytesSent: 24700000 },
                    { type: 'inbound-rtp', kind: 'audio', framesDecoded: 0, packetsReceived: 9999, packetsLost: 0, bytesReceived: 738900 },
                    { type: 'inbound-rtp', kind: 'video', framesDecoded: 0, packetsReceived: 0, packetsLost: 0, bytesReceived: 0 },
                ]);
            };
            return true;
        }, body2.user.id);
        expect(armed).toBeTruthy();

        // Open the panel and assert the rendered reason text.
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.evaluate(() => (window as any).VoiceManager.refreshVoiceDiag());
        await page.waitForFunction(() => {
            const t = document.getElementById('voice-diag-list');
            return t && t.innerText.indexOf('Black feed') !== -1;
        }, undefined, { timeout: 10000 });
        const text = await page.locator('#voice-diag-list').innerText();
        expect(text).toContain('Black feed');
        expect(text).toContain('Load'); // actionable fix hint
        expect(text).toContain('rejoin the call');
        expect(text).toContain('E2EE');
        // The send-audio-missing-transform reason (mic sent unencrypted).
        expect(text).toContain('WITHOUT end-to-end encryption');

        // Restore the real getStats. (The detached transforms can't be
        // re-attached — Chrome throws "Transform cannot be reused" — which is
        // exactly why the app always creates FRESH transforms in
        // reapplyAllE2EE. The call is torn down right after, so leaving them
        // detached is fine.)
        await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(s.peers)[0];
            const pc = s.peers[uid];
            if (pc && (window as any).__origGetStats2) pc.getStats = (window as any).__origGetStats2;
        });

        await ctx2.close();
    });
});
