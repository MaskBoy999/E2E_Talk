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
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            return (navigator.mediaDevices as any).getUserMedia({ video: true });
        };
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
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

async function createVoiceServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'SNR_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const encName = await page.evaluate(async (name) => {
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
    }, 'General');
    const createCh = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'voice' },
    });
    expect(createCh.ok()).toBeTruthy();
    const chJson = await createCh.json();
    return { serverId, channelId: chJson.id, token };
}

const markerSnapshot = (page: any) => page.evaluate(() => {
    return Array.from(document.querySelectorAll('.remote-video-tile')).map((v) => ({
        marker: (v as HTMLElement).dataset.marker,
        kind: (v as HTMLElement).dataset.kind,
        uid: (v as HTMLElement).dataset.uid,
        srcSet: !!(v as HTMLVideoElement).srcObject,
    }));
});

test.describe('speaking must not refresh video (green-bubble glitch)', () => {
    test('DM call: partner speaking toggles do not replace A\'s video tiles', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        await mockMedia(page);
        const u1 = await registerUser(page, 'snr1_' + ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'snr2_' + ts);

        await setupFriends(page, page2, u1, u2);
        const userData = await (await page.request.get(`${BASE}/api/user/${u2.user.username}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${u1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();

        await waitForWs(page);
        await waitForWs(page2);

        // Open the DM view on A — reload first so the conversation list
        // populates reliably, then click the conversation.
        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await waitForWs(page);
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

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: u2.user.username });

        await page2.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await page.waitForTimeout(2500);

        // Both turn on camera via the API (works whether the panel or the mini
        // bar is showing — no dependency on which controls are rendered).
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera()).catch(() => {});
        await page2.evaluate(() => (window as any).VoiceManager.toggleCamera()).catch(() => {});
        await page.waitForTimeout(2500);

        // A's DM panel must show the remote tile with a live stream
        await page.waitForFunction(() => {
            const v = document.querySelector('.remote-video-tile[data-kind="camera"]') as HTMLVideoElement;
            return v && v.srcObject && v.srcObject.getTracks().length > 0;
        }, undefined, { timeout: 10000 });

        await page.evaluate(() => {
            document.querySelectorAll('.remote-video-tile').forEach((v, i) => {
                (v as HTMLElement).dataset.marker = 'A-v' + i;
            });
            (window as any).__rebuilds = 0;
            const obs = new MutationObserver(() => { (window as any).__rebuilds++; });
            const body = document.getElementById('dm-call-body')!;
            obs.observe(body, { childList: true });
            (window as any).__obs = obs;
        });

        const before = await markerSnapshot(page);

        // Partner speaks via the REAL server path (voice_state -> broadcast -> A)
        await page2.evaluate(() => (window as any).VoiceManager._debug.forceSpeaking(true));
        await page.waitForTimeout(1500);
        await page2.evaluate(() => (window as any).VoiceManager._debug.forceSpeaking(false));
        await page.waitForTimeout(1500);
        await page2.evaluate(() => (window as any).VoiceManager._debug.forceSpeaking(true));
        await page.waitForTimeout(1500);

        const after = await markerSnapshot(page);
        const rebuilds = await page.evaluate(() => {
            if ((window as any).__obs) (window as any).__obs.disconnect();
            return (window as any).__rebuilds;
        });

        const beforeMarkers = before.map((t: any) => t.marker).filter(Boolean).sort();
        const afterMarkers = after.map((t: any) => t.marker).filter(Boolean).sort();
        expect(afterMarkers).toEqual(beforeMarkers);
        // No childList mutation on the DM body: tiles were never replaced.
        expect(rebuilds).toBe(0);
    });

    test('server voice channel: pre-joined camera + speaking toggles keep the self tile alive', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        await mockMedia(page);
        const u1 = await registerUser(page, 'snr3_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'snr4_' + ts);

        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        await page.request.post(`${BASE}/api/servers/${srv.serverId}/invite`, {
            headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code },
        });

        // A turns the camera ON *BEFORE* joining the voice channel (allowed) —
        // this used to desync the self camera flag and rebuild the self row on
        // the first speaking toggle.
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await page.waitForTimeout(1200);

        await page.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + srv.serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.waitForTimeout(2500);

        await page.click('#voice-bar-popup').catch(() => {});
        await page.waitForSelector('.remote-video-tile', { timeout: 10000 });
        await page.waitForTimeout(2500);

        await page.evaluate(() => {
            document.querySelectorAll('.remote-video-tile').forEach((v, i) => {
                (v as HTMLElement).dataset.marker = 'A-s' + i;
            });
            (window as any).__rebuilds = 0;
            const obs = new MutationObserver(() => { (window as any).__rebuilds++; });
            const body = document.getElementById('voice-popup-members')!;
            obs.observe(body, { childList: true });
            (window as any).__obs = obs;
        });

        const before = await markerSnapshot(page);

        // Partner speaks via the real server path
        await page2.evaluate(() => (window as any).VoiceManager._debug.forceSpeaking(true));
        await page.waitForTimeout(1500);
        await page2.evaluate(() => (window as any).VoiceManager._debug.forceSpeaking(false));
        await page.waitForTimeout(1500);

        const after = await markerSnapshot(page);
        const rebuilds = await page.evaluate(() => {
            if ((window as any).__obs) (window as any).__obs.disconnect();
            return (window as any).__rebuilds;
        });

        const beforeMarkers = before.map((t: any) => t.marker).filter(Boolean).sort();
        const afterMarkers = after.map((t: any) => t.marker).filter(Boolean).sort();
        expect(afterMarkers).toEqual(beforeMarkers);
        expect(rebuilds).toBe(0);
    });
});
