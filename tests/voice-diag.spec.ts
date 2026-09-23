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

async function openVoiceDiag(page: any) {
    // Open the settings modal, switch to the Voice tab, and make sure the
    // Advanced diagnostics panel is the one rendered.
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
    await page.click('.settings-tab[data-tab="voice-settings"]');
    await page.waitForSelector('#voice-diag-list', { state: 'visible', timeout: 10000 });
}

test.describe('call diagnostics (Settings → Voice → Advanced)', () => {
    test('empty state: no call → panel says not in a call, getPeerDiag resolves empty', async ({ page }) => {
        const ts = Date.now();
        await mockMedia(page);
        await registerUser(page, 'diag0_' + ts);
        await waitForWs(page);
        await openVoiceDiag(page);
        const text = await page.locator('#voice-diag-list').innerText();
        expect(text).toContain('Not in a call');
        const diag = await page.evaluate(() => (window as any).VoiceManager.getPeerDiag());
        expect(diag).toEqual([]);
    });

    test('DM call: live getStats render — send/recv frames, packet loss, E2EE transforms, refresh', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'diag2_' + ts);
        const body1 = await registerUser(page, 'diag1_' + ts);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, body2.user.username);

        // A turns the camera on so there's a live video sender to diagnose.
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });

        // Wait until A's diagnostics show a CONNECTED peer with the video
        // sender actually encoding. Poll the public API itself (a camera-toggle
        // renegotiation can transiently replace the peer pc — the diag must
        // reflect the settled state).
        await page.waitForFunction((bUid) => {
            return (window as any).VoiceManager.getPeerDiag().then((arr: any[]) => {
                const d = arr.find((x: any) => x.uid === bUid);
                return d && d.connectionState === 'connected' && d.senders.video && d.senders.video.frames > 0;
            });
        }, body2.user.id, { timeout: 45000 });

        // Structured diagnostics via the public API. The camera-toggle
        // renegotiation restarts the encoder, which momentarily resets
        // framesEncoded to 0 — retry until we catch the settled (encoding)
        // state, which is exactly what the panel would show moments later.
        let diag: any = null;
        for (let i = 0; i < 60; i++) {
            diag = await page.evaluate((bUid) => (window as any).VoiceManager.getPeerDiag(), body2.user.id);
            const d = diag.find((x: any) => x.uid === body2.user.id);
            // Settled state: connected, video encoding, and the remote audio
            // receiver present. (framesEncoded momentarily reads 0 while a
            // renegotiation restarts an encoder, so require the FULL settled
            // picture before asserting.)
            if (d && d.connectionState === 'connected' && d.senders.video && d.senders.video.frames > 0
                && d.senders.audio && d.senders.audio.tracks >= 1 && d.receivers.audio) break;
            await page.waitForTimeout(500);
        }
        expect(diag.length).toBe(1);
        const d = diag[0];
        expect(d.uid).toBe(body2.user.id);
        expect(d.connectionState).toBe('connected');
        expect(d.senders.video.frames).toBeGreaterThan(0);
        expect(d.senders.video.transform).toBe(true);
        expect(d.senders.video.tracks).toBeGreaterThanOrEqual(1);
        expect(d.senders.audio.tracks).toBeGreaterThanOrEqual(1);
        expect(d.senders.audio.transform).toBe(true);
        expect(d.receivers.audio.tracks).toBeGreaterThanOrEqual(1);
        expect(d.receivers.audio.transform).toBe(true);

        // Rendered panel: open settings → Voice tab → Advanced diagnostics.
        await openVoiceDiag(page);
        await page.waitForFunction(() => {
            const t = document.getElementById('voice-diag-list');
            return t && t.innerText.indexOf('send video') !== -1 && t.innerText.indexOf('E2EE ✓') !== -1;
        }, undefined, { timeout: 15000 });
        const text = await page.locator('#voice-diag-list').innerText();
        expect(text).toContain('send video');
        expect(text).toContain('recv audio');
        expect(text).toContain('E2EE ✓');
        expect(text).toMatch(/frames \d+/);
        expect(text).toMatch(/loss \d+/);
        expect(text).toContain('Updated');

        // Manual refresh keeps rendering fresh data.
        await page.click('#voice-diag-refresh');
        await page.waitForTimeout(800);
        const text2 = await page.locator('#voice-diag-list').innerText();
        expect(text2).toContain('send video');
        expect(text2).toMatch(/Updated/);

        // Auto-refresh is on by default and paints while the tab is visible.
        const auto = await page.isChecked('#voice-diag-auto');
        expect(auto).toBe(true);

        await ctx2.close();
    });

    test('per-peer ping / rtt / jitter are reported (1.8)', async ({ page }) => {
        const ts = Date.now();
        await mockMedia(page);
        await registerUser(page, 'diagping_' + ts);
        await openVoiceDiag(page);

        // Feed the collector a synthetic getStats report. The three latency
        // numbers come from three different report types, so this pins all of
        // them: the connection ping from the nominated candidate pair (which
        // carries no `kind` and is therefore easy to drop by accident), our
        // outbound RTT from the peer's RTCP receiver report, and inbound
        // jitter. Numbers only — the panel is in-app and names nothing.
        await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            const stats = new Map<string, any>();
            stats.set('CP1', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.042 });
            stats.set('OUT1', { type: 'outbound-rtp', kind: 'audio', packetsSent: 100, bytesSent: 1000 });
            stats.set('RIN1', { type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.038 });
            stats.set('IN1', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 90, packetsLost: 1, bytesReceived: 900, jitter: 0.012 });
            S.connected = true;
            S.peers = {
                fake_peer_uid_1234: {
                    connectionState: 'connected',
                    signalingState: 'stable',
                    getStats: () => Promise.resolve(stats),
                    getSenders: () => [],
                    getReceivers: () => [],
                },
            };
        });

        const diag = await page.evaluate(() => (window as any).VoiceManager.getPeerDiag());
        expect(diag.length).toBe(1);
        expect(diag[0].pingMs).toBeCloseTo(42, 5);
        expect(diag[0].senders.audio.rttMs).toBeCloseTo(38, 5);
        expect(diag[0].receivers.audio.jitterMs).toBeCloseTo(12, 5);
        expect(diag[0].receivers.audio.loss).toBe(1);

        // And the panel actually paints them.
        await page.evaluate(() => (window as any).VoiceManager.refreshVoiceDiag());
        const text = await page.locator('#voice-diag-list').innerText();
        expect(text).toContain('ping 42 ms');
        expect(text).toContain('rtt 38 ms');
        expect(text).toContain('jitter 12 ms');
        expect(text).not.toContain('fake_peer_uid_1234'); // shortUid truncates, never the raw id
    });
});
