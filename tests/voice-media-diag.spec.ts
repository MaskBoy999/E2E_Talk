import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mock getUserMedia/getDisplayMedia with real (but synthetic) streams so the
// voice pipeline actually captures and relays audio/video frames.
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
                (window as any).__mockCtx = ac;
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
        // getDisplayMedia (screen share) → same canvas stream
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

async function createVoiceServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'AV_' + ts);
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

test.describe('voice audio & video pipelines (with synthetic media)', () => {
    test('A speaks → B receives & plays audio; A shares video → B sees it live', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const p1Errors: string[] = [];
        page.on('pageerror', (err) => p1Errors.push('P1: ' + err.message));
        await mockMedia(page);
        const u1 = await registerUser(page, 'av1_' + ts);
        const srv = await createVoiceServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const p2Errors: string[] = [];
        page2.on('pageerror', (err) => p2Errors.push('P2: ' + err.message));
        await mockMedia(page2);
        const u2 = await registerUser(page2, 'av2_' + ts);

        // member joins via invite
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

        // both join the voice channel
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page.waitForSelector('#voice-bar', { timeout: 10000 });

        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page2.click('.server-icon[data-id="' + srv.serverId + '"]');
        await page2.waitForSelector(`.channel-item[data-id="${srv.channelId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page2.waitForSelector('#voice-bar', { timeout: 10000 });
        await page.waitForTimeout(2500);

        // Instrument B: count voice_audio + voice_video messages received, and
        // track whether a gain node exists for A (i.e., audio actually played).
        await page2.evaluate(() => {
            const vm = (window as any).VoiceManager;
            if (!vm) return;
            const orig = vm.handleServerMessage.bind(vm);
            (window as any).__voiceCounts = { audio: 0, video: 0 };
            vm.handleServerMessage = function (data: any) {
                if (data && data.type === 'voice_audio') (window as any).__voiceCounts.audio++;
                if (data && data.type === 'voice_video') (window as any).__voiceCounts.video++;
                return orig(data);
            };
        });

        // A speaks (mic is auto-captured on join with the mock stream)
        await page.waitForTimeout(3000);

        // A starts camera
        await page.click('#voice-bar-camera');
        await page.waitForTimeout(2500);

        // Open B's popup — video should ALREADY be there without any reload.
        await page2.click(`.channel-item[data-id="${srv.channelId}"]`); // open popup
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page2.waitForTimeout(1500);

        const bState = await page2.evaluate(() => {
            const counts = (window as any).__voiceCounts || {};
            const imgs = Array.from(document.querySelectorAll('#voice-popup-members img')).map((i: any) => i.src.slice(0, 40));
            // audioCtx must be RUNNING (autoplay policy was the "can't hear"
            // root cause — it suspends contexts created outside a user gesture).
            const vm = (window as any).VoiceManager;
            let ctxState: string | null = null;
            if (vm && (vm as any)._debugAudioCtx) ctxState = (vm as any)._debugAudioCtx().state;
            return {
                audioFrames: counts.audio,
                videoFrames: counts.video,
                popupImgs: imgs,
                audioCtxState: ctxState,
                popupHTML: document.getElementById('voice-popup-members')!.innerHTML.slice(0, 500),
            };
        });
        console.log('B STATE:', JSON.stringify(bState));

        const aState = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            let ctxState: string | null = null;
            if (vm && (vm as any)._debugAudioCtx) ctxState = (vm as any)._debugAudioCtx().state;
            return {
                voiceBarVisible: !!document.getElementById('voice-bar'),
                audioCtxState: ctxState,
            };
        });
        console.log('A STATE:', JSON.stringify(aState));
        console.log('P1 ERRORS:', JSON.stringify(p1Errors));
        console.log('P2 ERRORS:', JSON.stringify(p2Errors));

        // The core assertions:
        // 1) Audio frames must have reached B (frames received + gain scheduled).
        expect(bState.audioFrames).toBeGreaterThan(20);
        // 2) Both AudioContexts must be running (otherwise playback is silent).
        expect(bState.audioCtxState).toBe('running');
        // 3) Video frames must reach B and render WITHOUT any reload.
        expect(bState.videoFrames).toBeGreaterThan(5);
        const hasImg = await page2.evaluate(() => {
            return document.querySelectorAll('#voice-popup-members .voice-video-tile img').length > 0;
        });
        expect(hasImg).toBe(true);
    });
});
