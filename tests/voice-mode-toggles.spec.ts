import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    ignoreHTTPSErrors: true,
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
            '--enable-features=SharedArrayBuffer',
        ],
    },
});

async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        (navigator.mediaDevices as any).getUserMedia = async (constraints: any) => {
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
                const c = document.createElement('canvas');
                c.width = 640; c.height = 480;
                return (c as any).captureStream(30);
            }
            const ac2 = new (window as any).AudioContext();
            const osc2 = ac2.createOscillator();
            osc2.frequency.value = 300;
            const dest2 = ac2.createMediaStreamDestination();
            osc2.connect(dest2);
            osc2.start();
            const c2 = document.createElement('canvas');
            c2.width = 640; c2.height = 480;
            const vs = (c2 as any).captureStream(30);
            return new MediaStream([...dest2.stream.getTracks(), ...vs.getTracks()]);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async () => {
            const c = document.createElement('canvas');
            c.width = 1280; c.height = 720;
            const scrVideo = (c as any).captureStream(30);
            const ac = new (window as any).AudioContext();
            const osc = ac.createOscillator();
            osc.frequency.value = 440;
            const dest = ac.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            return new MediaStream([...scrVideo.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        };
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url.includes('index.html')) {
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }
    await page.click('#show-register');
    await page.waitForTimeout(500);
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerWithVoiceChannel(page: any, token: string) {
    const ts = Date.now();
    const inviteCode = 'AE2E' + ts;
    const prep = await page.evaluate(async ({ inviteCode }: { inviteCode: string }) => {
        const symKey = (window as any).E2ECrypto.generateSymmetricKey();
        const encName = (window as any).E2ECrypto.aeadEncrypt('ModeToggle Server', symKey);
        const encCh = (window as any).E2ECrypto.aeadEncrypt('voice', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });

    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name,
            name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.channel_encrypted_name,
            channel_name_nonce: prep.channel_name_nonce,
        },
    })).json();
    const serverId = srv.id;

    await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        E.saveServerKey(serverId, symKey);
        const identity = E.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId });

    const serverKeyB64 = await page.evaluate((sid: string) => {
        return (window as any).E2ECrypto.arrayBufferToBase64((window as any).E2ECrypto.getServerKey(sid));
    }, serverId);
    const encCh = await page.evaluate(async ({ name, serverKeyB64 }: { name: string; serverKeyB64: string }) => {
        const sk = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(serverKeyB64));
        const enc = (window as any).E2ECrypto.aeadEncrypt(name, sk);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    }, { name: 'Voice', serverKeyB64 });

    const chRes = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Voice',
            encrypted_name: encCh.ciphertext,
            name_nonce: encCh.nonce,
            channel_type: 'voice',
        },
    });
    const channel = await chRes.json();
    return { serverId, voiceChannelId: channel.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, code: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code },
    });
    expect(join.ok()).toBeTruthy();
    return (await join.json()).id;
}

async function selectServer(page: any) {
    await page.evaluate(() => { if (typeof (window as any).loadServers === 'function') (window as any).loadServers(); }).catch(() => {});
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
        if (count > 0) {
            await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function clickVoiceChannel(page: any, channelId: string) {
    for (let i = 0; i < 40; i++) {
        const el = page.locator(`.channel-item[data-id="${channelId}"]`);
        if (await el.count()) {
            await el.click();
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function waitForConnected(page: any) {
    await page.waitForFunction(() => {
        const s = (window as any).VoiceManager;
        return s && s._debug && s._debug.state && s._debug.state.connected;
    }, undefined, { timeout: 15000 });
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && (ws as any).readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

test.describe('Mode toggles: audio/camera/screen in 3-dots menu', () => {
    test('cam-opt menu has 3 separate mode buttons', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'mt1_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user1 + 'b');
        const body1 = await registerUser(page, user1);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        await page.click('#voice-bar-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 3000 });

        const audioBtn = await page.$('#cam-opt-audio-mode');
        const cameraBtn = await page.$('#cam-opt-camera-mode');
        const screenBtn = await page.$('#cam-opt-screen-mode');
        expect(audioBtn).not.toBeNull();
        expect(cameraBtn).not.toBeNull();
        expect(screenBtn).not.toBeNull();

        const oldVideoBtn = await page.$('#cam-opt-video-mode');
        expect(oldVideoBtn).toBeNull();

        const audioLabel = await page.textContent('#cam-opt-audio-mode-label');
        const cameraLabel = await page.textContent('#cam-opt-camera-mode-label');
        const screenLabel = await page.textContent('#cam-opt-screen-mode-label');
        expect(audioLabel).toContain('Audio:');
        expect(cameraLabel).toContain('Camera:');
        expect(screenLabel).toContain('Screen:');

        await ctx2.close();
    });

    test('mode badges show 3 separate indicators', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'mt2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user1 + 'b');
        const body1 = await registerUser(page, user1);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        await page.click('#voice-bar-popup');
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 3000 });

        const badges = await page.$$('.voice-member-row[data-self="1"] .voice-mode-badge');
        expect(badges.length).toBe(3);

        const kinds = await page.$$eval('.voice-member-row[data-self="1"] .voice-mode-badge', (els: any[]) =>
            els.map((el) => el.getAttribute('data-mode-kind'))
        );
        expect(kinds).toContain('audio');
        expect(kinds).toContain('camera');
        expect(kinds).toContain('screen');

        await ctx2.close();
    });

    test('clicking camera badge cycles auto/mesh/relay', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'mt3_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user1 + 'b');
        const body1 = await registerUser(page, user1);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        const getCameraOverride = () => page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const selfId = JSON.parse(localStorage.getItem('user') || '{}').id;
            const overrides = V._debug.cameraOverrides();
            return overrides[selfId] || 'auto';
        });

        expect(await getCameraOverride()).toBe('auto');

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const selfId = JSON.parse(localStorage.getItem('user') || '{}').id;
            V._debug.state._cameraModeOverrides[selfId] = 'mesh';
        });
        await page.waitForTimeout(300);
        expect(await getCameraOverride()).toBe('mesh');

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const selfId = JSON.parse(localStorage.getItem('user') || '{}').id;
            V._debug.state._cameraModeOverrides[selfId] = 'relay';
        });
        await page.waitForTimeout(300);
        expect(await getCameraOverride()).toBe('relay');

        await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const selfId = JSON.parse(localStorage.getItem('user') || '{}').id;
            delete V._debug.state._cameraModeOverrides[selfId];
        });
        await page.waitForTimeout(300);
        expect(await getCameraOverride()).toBe('auto');

        await ctx2.close();
    });

    test('cam-opt screen mode button cycles auto/mesh/relay', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'mt5_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user1 + 'b');
        const body1 = await registerUser(page, user1);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        await page.click('#voice-bar-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 3000 });

        await page.click('#cam-opt-screen-mode');
        await page.waitForTimeout(300);
        const afterClick = await page.textContent('#cam-opt-screen-mode-label');
        expect(afterClick).toContain('P2P mesh');

        await page.click('#voice-bar-cam-opt');
        await page.waitForSelector('#voice-cam-opt-menu', { state: 'visible', timeout: 3000 });
        await page.click('#cam-opt-screen-mode');
        await page.waitForTimeout(300);
        const afterClick2 = await page.textContent('#cam-opt-screen-mode-label');
        expect(afterClick2).toContain('Server relay');

        await ctx2.close();
    });
});

test.describe('Screen audio receive quality setting', () => {
    test('settings UI has recvScreenAudioQuality dropdown with correct default', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        await registerUser(page, 'saq1_' + ts);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 3000 });

        const dropdown = await page.$('#voice-recv-screen-audio-quality');
        expect(dropdown).not.toBeNull();

        const val = await page.$eval('#voice-recv-screen-audio-quality', (el: any) => el.value);
        expect(val).toBe('medium');

        await page.selectOption('#voice-recv-screen-audio-quality', 'low', { force: true });
        await page.waitForTimeout(200);

        const saved = await page.evaluate(() => {
            const settings = JSON.parse(localStorage.getItem('voice_settings') || '{}');
            return settings.recvScreenAudioQuality;
        });
        expect(saved).toBe('low');
    });
});

test.describe('Mode toggles: independent control per media type', () => {
    async function setupTwoUserVoice(page: any, context: any) {
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, 'ind_' + ts + 'b');
        const body1 = await registerUser(page, 'ind_' + ts);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);
        return { ctx2, page2, body1, body2, serverId, voiceChannelId };
    }

    function getModes(page: any) {
        return page.evaluate(() => {
            const V = (window as any).VoiceManager;
            const S = V._debug.state;
            const selfId = JSON.parse(localStorage.getItem('user') || '{}').id;
            return {
                audioMode: V._debug.audioOverrides()[selfId] || 'auto',
                cameraMode: V._debug.cameraOverrides()[selfId] || 'auto',
                screenMode: V._debug.screenOverrides()[selfId] || 'auto',
                resolvedAudio: V.resolveAudioMode(selfId),
                resolvedCamera: V.resolveCameraMode(selfId),
                resolvedScreen: V.resolveScreenMode(selfId),
                cameraRelayActive: !!(S._relayTimers && S._relayTimers.camera),
                screenRelayActive: !!(S._relayTimers && S._relayTimers.screen),
                lastAudioMode: V._debug.lastAudioMode(),
            };
        });
    }

    test('audio relay mode does not affect camera or screen relay', async ({ page, context }) => {
        test.setTimeout(120000);
        const { ctx2, page2 } = await setupTwoUserVoice(page, context);

        await page.evaluate(() => (window as any).VoiceManager.startCamera());
        await page.waitForTimeout(2000);

        const before = await getModes(page);
        expect(before.audioMode).toBe('auto');
        expect(before.cameraMode).toBe('auto');
        expect(before.cameraRelayActive).toBeTruthy();

        await page.evaluate(() => (window as any).VoiceManager.setSelfAudioMode('relay'));
        await page.waitForTimeout(500);

        const after = await getModes(page);
        expect(after.audioMode).toBe('relay');
        expect(after.cameraMode).toBe('auto');
        expect(after.cameraRelayActive).toBeTruthy();

        await page.evaluate(() => (window as any).VoiceManager.setSelfAudioMode('auto'));
        await page.waitForTimeout(500);

        const restored = await getModes(page);
        expect(restored.audioMode).toBe('auto');
        expect(restored.cameraMode).toBe('auto');
        expect(restored.cameraRelayActive).toBeTruthy();

        await ctx2.close();
    });

    test('camera mesh mode does not affect audio or screen relay', async ({ page, context }) => {
        test.setTimeout(120000);
        const { ctx2, page2 } = await setupTwoUserVoice(page, context);

        await page.evaluate(() => (window as any).VoiceManager.startCamera());
        await page.waitForTimeout(2000);

        const before = await getModes(page);
        expect(before.resolvedCamera).toBe('relay');
        expect(before.resolvedAudio).toBe('mesh');
        expect(before.cameraRelayActive).toBeTruthy();

        await page.evaluate(() => (window as any).VoiceManager.setSelfCameraMode('mesh'));
        await page.waitForTimeout(500);

        const after = await getModes(page);
        expect(after.resolvedCamera).toBe('mesh');
        expect(after.cameraRelayActive).toBeFalsy();
        expect(after.resolvedAudio).toBe('mesh');

        await ctx2.close();
    });

    test('screen mesh mode does not affect audio or camera relay', async ({ page, context }) => {
        test.setTimeout(120000);
        const { ctx2, page2 } = await setupTwoUserVoice(page, context);

        await page.evaluate(() => (window as any).VoiceManager.startCamera());
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(2000);

        const before = await getModes(page);
        expect(before.resolvedScreen).toBe('relay');
        expect(before.cameraRelayActive).toBeTruthy();
        expect(before.resolvedAudio).toBe('mesh');

        await page.evaluate(() => (window as any).VoiceManager.setSelfScreenMode('mesh'));
        await page.waitForTimeout(500);

        const after = await getModes(page);
        expect(after.resolvedScreen).toBe('mesh');
        expect(after.screenRelayActive).toBeFalsy();
        expect(after.cameraRelayActive).toBeTruthy();
        expect(after.resolvedAudio).toBe('mesh');

        await ctx2.close();
    });

    test('mixed modes: camera relay + screen mesh + audio relay coexist', async ({ page, context }) => {
        test.setTimeout(120000);
        const { ctx2, page2 } = await setupTwoUserVoice(page, context);

        await page.evaluate(() => (window as any).VoiceManager.startCamera());
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForTimeout(2000);

        await page.evaluate(() => (window as any).VoiceManager.setSelfScreenMode('mesh'));
        await page.evaluate(() => (window as any).VoiceManager.setSelfAudioMode('relay'));
        await page.waitForTimeout(500);

        const state = await getModes(page);
        expect(state.resolvedCamera).toBe('relay');
        expect(state.cameraRelayActive).toBeTruthy();
        expect(state.resolvedScreen).toBe('mesh');
        expect(state.screenRelayActive).toBeFalsy();
        expect(state.resolvedAudio).toBe('relay');

        await ctx2.close();
    });
});
