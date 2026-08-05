import { test, expect } from '@playwright/test';

// Decisive app-level bisect: the app's real DM call with E2EE fully stubbed
// OFF (window.RTCRtpScriptTransform = undefined before app scripts run).
//   - If audio then DECODES: the bug lives in the app's E2EE application
//     (worker/key/transform attachment), NOT in the audio graph.
//   - If audio is STILL silent: the bug is a non-E2EE app audio bug.
// Also dumps the negotiated SDP audio m-line + codec stats so we can compare
// with the E2EE-on run.

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
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

async function appDump(page: any) {
    return await page.evaluate(async () => {
        // @ts-ignore
        const V = window.VoiceManager;
        const S = V._debug.state;
        const out: any = {
            roomKeyB64: S.roomKeyB64,
            audioCtx: S.audioCtx ? S.audioCtx.state : 'none',
            masterGain: S.masterGain ? S.masterGain.gain.value : null,
            memberGains: Object.keys(S.memberGains || {}),
            remoteAudio: {} as any,
            stats: {} as any,
            sdpAudio: '',
            senders: [] as any[],
            receivers: [] as any[],
        };
        Object.keys(S.remoteStreams || {}).forEach((uid) => {
            const a = S.remoteStreams[uid] && S.remoteStreams[uid].audio;
            out.remoteAudio[uid] = a ? a.getTracks().map((t: any) => ({ kind: t.kind, state: t.readyState, muted: t.muted })) : null;
        });
        const uids = Object.keys(S.peers || {});
        if (uids.length) {
            const pc = S.peers[uids[0]];
            out.senders = pc.getSenders().map((s: any) => ({ kind: s.track && s.track.kind, transform: !!s.transform }));
            out.receivers = pc.getReceivers().map((r: any) => ({ kind: r.track && r.track.kind, transform: !!r.transform }));
            if (pc.localDescription && pc.localDescription.sdp) {
                const am = pc.localDescription.sdp.split('m=audio')[1];
                if (am) out.sdpAudio = am.split('\r\n').slice(0, 8).join(' | ');
            }
            out.micTrack = S.localStreams && S.localStreams.mic
                ? S.localStreams.mic.getTracks().map((t: any) => ({ kind: t.kind, state: t.readyState, muted: t.muted, enabled: t.enabled }))
                : [];
            try {
                const report = await pc.getStats();
                report.forEach((s: any) => {
                    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                        out.stats.audio = { packets: s.packetsReceived, samples: s.totalSamplesReceived, energy: s.totalAudioEnergy, jitterEmitted: s.jitterBufferEmittedCount };
                    }
                    if (s.type === 'outbound-rtp' && s.kind === 'audio') {
                        out.stats.outAudio = { packets: s.packetsSent, bytes: s.bytesSent, samplesSent: s.totalSamplesSent, energy: s.totalAudioEnergy };
                    }
                    if (s.type === 'media-source' || (s.type === 'track' && s.kind === 'audio')) {
                        out.stats.track = { audioLevel: s.audioLevel, energy: s.totalAudioEnergy, samplesSent: s.totalSamplesSent, framesSent: s.framesSent };
                    }
                    if (s.type === 'codec') {
                        out.stats.codec = out.stats.codec || {};
                        out.stats.codec[s.mimeType] = { pt: s.payloadType, clock: s.clockRate, channels: s.channels };
                    }
                });
            } catch (_) {}
        }
        return out;
    });
}

for (const e2ee of ['on', 'off'] as const) {
    test(`app DM call audio decode: E2EE ${e2ee.toUpperCase()}`, async ({ browser }) => {
        test.setTimeout(180000);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        if (e2ee === 'off') {
            await page.addInitScript(() => {
                Object.defineProperty(window, 'RTCRtpScriptTransform', { value: undefined, configurable: true });
            });
            await page2.addInitScript(() => {
                Object.defineProperty(window, 'RTCRtpScriptTransform', { value: undefined, configurable: true });
            });
        }
        const body1 = await registerUser(page, `ee${e2ee === 'on' ? 'a' : 'b'}1_` + Date.now().toString().slice(-6));
        const body2 = await registerUser(page2, `ee${e2ee === 'on' ? 'a' : 'b'}2_` + Date.now().toString().slice(-6));
        await waitForWs(page);
        await waitForWs(page2);
        await setupFriends(page, page2, body1, body2);
        await createDm(page, page2, body1, body2);
        await page.reload();
        await page2.reload();
        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);
        await page.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
        await page.click('.dm-call-btns .dm-call-btn');
        await page.waitForTimeout(2000);
        await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await page.waitForTimeout(12000);

        const d1 = await appDump(page);
        const d2 = await appDump(page2);
        console.log(`=====APP E2EE=${e2ee}=====\n` + JSON.stringify({ caller: d1, callee: d2 }, null, 2));
    });
}
