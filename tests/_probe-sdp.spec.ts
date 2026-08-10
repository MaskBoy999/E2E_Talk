import { test, expect } from '@playwright/test';

const BASE = 'https://127.0.0.1:3443';
test.use({
    launchOptions: {
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--disable-background-timer-throttling',
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
    return dm;
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

test('SDP probe: encrypt extmap presence on both sides', async ({ browser }) => {
    test.setTimeout(180000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    for (const p of [pageA, pageB]) {
        await p.addInitScript(() => {
            try {
                localStorage.setItem('voice_settings', JSON.stringify({
                    noiseSuppressionMode: 'off',
                    echoCancellation: false,
                    micVolume: 100,
                    speakerVolume: 100,
                }));
            } catch (_) {}
            (window as any).__enableVoiceAudioDebug = true;
        });
    }

    const a = await registerUser(pageA, 'sdpA' + Date.now());
    const b = await registerUser(pageB, 'sdpB' + Date.now());
    await setupFriends(pageA, pageB, a, b);
    await createDm(pageA, pageB, a, b);
    await pageA.reload();
    await pageB.reload();
    await waitForWs(pageA);
    await waitForWs(pageB);

    await openDm(pageA);
    await pageA.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
    await pageA.click('.dm-call-btns .dm-call-btn');
    await pageA.waitForTimeout(2000);
    await pageB.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
    await pageB.click('#incoming-call-accept');
    // Timeline capture 1: A's OFFER as soon as it exists (right after accept)
    let offerA: any = null;
    for (let i = 0; i < 40; i++) {
        offerA = await pageA.evaluate(() => {
            const V = (window as any).VoiceManager._debug.state;
            const uid = Object.keys(V.peers || {})[0];
            const pc = uid ? V.peers[uid] : null;
            if (!pc || !pc.localDescription) return null;
            const sdp = pc.localDescription.sdp || '';
            return {
                type: pc.localDescription.type,
                hasEncrypt: sdp.includes('encrypt'),
                sig: pc.signalingState,
                exts: sdp.split('\n').filter((l: string) => l.startsWith('a=extmap') && (l.includes('encrypt') || l.includes('ssrc-audio-level'))),
            };
        });
        if (offerA) break;
        await pageA.waitForTimeout(300);
    }
    console.log('=====TIMELINE 1: A local SDP right after accept=====', JSON.stringify(offerA));
    await pageA.waitForTimeout(500);
    // Timeline capture 2: B's local SDP shortly after (answer)
    await pageB.waitForTimeout(1000);
    const answerB = await pageB.evaluate(() => {
        const V = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(V.peers || {})[0];
        const pc = uid ? V.peers[uid] : null;
        if (!pc || !pc.localDescription) return { type: 'none' };
        const sdp = pc.localDescription.sdp || '';
        return {
            type: pc.localDescription.type,
            hasEncrypt: sdp.includes('encrypt'),
            sig: pc.signalingState,
            exts: sdp.split('\n').filter((l: string) => l.startsWith('a=extmap') && (l.includes('encrypt') || l.includes('ssrc-audio-level'))),
        };
    });
    console.log('=====TIMELINE 2: B local SDP after accept=====', JSON.stringify(answerB));
    // Wait for a FULLY stable + connected state on both sides before dumping
    // (the earlier probe caught a mid-negotiation broken state).
    await pageA.waitForFunction(() => {
        const V = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(V.peers || {})[0];
        const pc = uid ? V.peers[uid] : null;
        return pc && pc.signalingState === 'stable' && pc.connectionState === 'connected';
    }, undefined, { timeout: 20000 });
    await pageB.waitForFunction(() => {
        const V = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(V.peers || {})[0];
        const pc = uid ? V.peers[uid] : null;
        return pc && pc.signalingState === 'stable' && pc.connectionState === 'connected';
    }, undefined, { timeout: 20000 });
    await pageA.waitForTimeout(1000);

    const dump = (page: any, label: string) => page.evaluate((lbl) => {
        const V = (window as any).VoiceManager._debug.state;
        const out: any = { label: lbl };
        try {
            const uid = Object.keys(V.peers)[0];
            const pc = V.peers[uid];
            const parseSdp = (sdp: string) => {
                const lines = sdp.split('\n');
                const mlines: any[] = [];
                let cur: any = null;
                for (const ln of lines) {
                    if (ln.startsWith('m=')) {
                        cur = { m: ln.trim(), encrypt: false, exts: [] };
                        mlines.push(cur);
                    } else if (cur && ln.startsWith('a=extmap')) {
                        cur.exts.push(ln.trim());
                        if (ln.includes('encrypt')) cur.encrypt = true;
                    }
                }
                return mlines;
            };
            out.local = parseSdp(pc.localDescription ? pc.localDescription.sdp : '(none)');
            out.remote = parseSdp(pc.remoteDescription ? pc.remoteDescription.sdp : '(none)');
            out.sig = pc.signalingState;
            out.conn = pc.connectionState;
            out.role = pc._polite ? 'polite' : 'impolite';
            out.senders = pc.getSenders().map((s: any) => ({ kind: s.track && s.track.kind, t: !!s.transform }));
            out.receivers = pc.getReceivers().map((r: any) => ({ kind: r.track && r.track.kind, t: !!r.transform }));
        } catch (e: any) {
            out.err = String(e);
        }
        return out;
    }, label);

    const sdpA = await dump(pageA, 'A');
    const sdpB = await dump(pageB, 'B');
    console.log('=====SDP A=====');
    console.log(JSON.stringify(sdpA, null, 1));
    console.log('=====SDP B=====');
    console.log(JSON.stringify(sdpB, null, 1));

    // RAW audio m-line dump — the filtered view might miss how Chrome spells it
    const rawA = await pageA.evaluate(() => {
        const V = (window as any).VoiceManager._debug.state;
        const uid = Object.keys(V.peers)[0];
        const sdp = V.peers[uid].localDescription.sdp;
        const lines = sdp.split('\n');
        const audio: string[] = [];
        let inAudio = false;
        for (const ln of lines) {
            if (ln.startsWith('m=audio')) inAudio = true;
            if (inAudio) audio.push(ln);
            if (inAudio && ln.startsWith('a=rtpmap') && ln.includes(' 111 ')) break;
        }
        return audio.join('\n');
    });
    console.log('=====RAW AUDIO M-LINE A=====\n' + rawA);
    expect(true).toBe(true);
});
