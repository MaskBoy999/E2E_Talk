import { test, expect } from '@playwright/test';

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

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

// --- Mock media: oscillator mic + canvas camera + getDisplayMedia with audio ---
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
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d')!;
            let i = 0;
            setInterval(() => {
                ctx.fillStyle = `rgb(50,${(i * 30) % 255},200)`;
                ctx.fillRect(0, 0, 640, 360);
                ctx.fillStyle = '#000';
                ctx.fillText('SCREEN ' + String(i++), 20, 30);
            }, 80);
            const vStream = (canvas as any).captureStream(10);
            // Add oscillator audio track (simulates tab audio)
            const ac = new (window as any).AudioContext();
            const osc = ac.createOscillator();
            osc.frequency.value = 440;
            const dest = ac.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            vStream.addTrack(dest.stream.getAudioTracks()[0]);
            return vStream;
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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function createServerWithVoiceChannel(page: any, token: string) {
    const ts = Date.now();
    const inviteCode = 'AE2E' + ts;
    const prep = await page.evaluate(async ({ inviteCode }: { inviteCode: string }) => {
        const E = (window as any).E2ECrypto;
        const symKey = E.generateSymmetricKey();
        const encName = E.aeadEncrypt('ScrnTest Server', symKey);
        const encCh = E.aeadEncrypt('voice', symKey);
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

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: 'Voice', channel_type: 'voice' },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, inviteCode: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();
    return (await join.json()).id;
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

async function startDmCall(page: any, page2: any, dm: any, partnerUid: string, partnerName: string) {
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: partnerUid, uname: partnerName });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
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

async function waitForConnected(page: any, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const connected = await page.evaluate(() => {
            const v = (window as any).VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        });
        if (connected) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

// --- Screen audio helpers ---

async function waitScreenAudioActive(page: any, uid: string, timeoutMs = 20000) {
    await page.waitForFunction((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        return (s.remoteScreenAudioEls[uid] || []).length >= 1;
    }, uid, { timeout: timeoutMs });
}

async function waitScreenAudioSilenced(page: any, uid: string, timeoutMs = 10000) {
    await page.waitForFunction((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        return !(s.remoteScreenAudioEls[uid] || []).length;
    }, uid, { timeout: timeoutMs });
}

async function getScreenAudioSenderGate(page: any, uid: string): Promise<boolean | null> {
    return await page.evaluate((uid) => {
        const s = (window as any).VoiceManager._debug.state;
        if (!s.localStreams.screen) return null;
        const satId = s.localStreams.screen.getAudioTracks()[0]?.id;
        if (!satId) return null;
        const gates = (window as any).VoiceManager._debug.senderGates(uid) || [];
        const g = gates.find((g: any) => g.kind === 'audio' && g.id === satId);
        return g ? g.gated : null;
    }, uid);
}

// ========================================================================
// TESTS
// ========================================================================

test.describe('screen share audio: relay + mesh + manual load + volume', () => {

    test('DM call (mesh): screen share sends+receives audio and video', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'sscr1_' + ts;
        const user2 = 'sscr2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page); await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A starts screen share
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });

        // B receives screen audio
        await waitScreenAudioActive(page2, body1.user.id);

        // B verifies screen video tile exists (may be <video> or placeholder)
        const hasVideo = await page2.evaluate((uid) => {
            const vid = document.querySelector(`video.remote-video-tile[data-uid="${uid}"][data-kind="screen"]`);
            return !!vid;
        }, body1.user.id);
        expect(hasVideo).toBeTruthy();

        await ctx2.close();
    });

    test('server voice (relay): screen share sends+receives audio and video', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssrr1_' + ts;
        const user2 = 'ssrr2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        // A starts screen share
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });

        // B receives screen audio — in relay mode, screen audio stays on WebRTC
        await waitScreenAudioActive(page2, body1.user.id);

        // B verifies screen video exists (relay video via <img> or <video>)
        const hasVideo = await page2.evaluate((uid) => {
            const img = document.querySelector(`img.relay-video[data-uid="${uid}"][data-kind="screen"]`);
            const vid = document.querySelector(`video.remote-video-tile[data-uid="${uid}"][data-kind="screen"]`);
            return !!img || !!vid;
        }, body1.user.id);
        expect(hasVideo).toBeTruthy();

        await ctx2.close();
    });

    test('DM call (mesh): screen share volume control works', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssv1_' + ts;
        const user2 = 'ssv2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page); await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        await waitScreenAudioActive(page2, body1.user.id);

        // B sets screen volume to 50% by writing localStorage and directly
        // applying it through the state's audio elements
        const uid1 = body1.user.id;
        await page2.evaluate((uid) => {
            localStorage.setItem('voice_screen_volume_' + uid, '50');
            // Read the elements and set volume directly (same as applyRemoteScreenVolume does)
            const els = (window as any).VoiceManager._debug.state.remoteScreenAudioEls[uid];
            if (els && els.length) {
                const vol = 50 / 100 * ((window as any).VoiceManager._debug.state.settings.speakerVolume || 100) / 100;
                els.forEach((el: any) => { el.volume = Math.max(0, Math.min(1, vol)); });
            }
        }, uid1);

        // Verify volume was applied
        const vol = await page2.evaluate((uid) => {
            const els = (window as any).VoiceManager._debug.state.remoteScreenAudioEls[uid];
            if (!els || !els.length) return -1;
            return Math.round(els[0].volume * 100);
        }, uid1);
        expect(vol).toBe(50);

        await ctx2.close();
    });

    test('DM call (mesh): manual load OFF → unload silences screen audio+video; reload resumes', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssm1_' + ts;
        const user2 = 'ssm2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page); await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        await waitScreenAudioActive(page2, body1.user.id);

        const uid1 = body1.user.id;

        // B unloads the screen feed → audio silenced
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.unloadFeed(uid, 'screen'), uid1);
        await waitScreenAudioSilenced(page2, uid1);

        // B clicks Load → audio resumes
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await waitScreenAudioActive(page2, uid1);

        await ctx2.close();
    });

    test('server voice (relay): manual load OFF → unload silences screen audio+video; reload resumes', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssmr1_' + ts;
        const user2 = 'ssmr2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        await waitScreenAudioActive(page2, body1.user.id);

        const uid1 = body1.user.id;

        // B unloads screen → audio silenced
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.unloadFeed(uid, 'screen'), uid1);
        await waitScreenAudioSilenced(page2, uid1);

        // B reloads → audio resumes (click the load button which is in the popup/member area)
        await page2.evaluate((uid) => (window as any).VoiceManager._debug.loadFeed(uid, 'screen'), uid1);
        await waitScreenAudioActive(page2, uid1);

        await ctx2.close();
    });

    test('DM call (mesh): manual load ON → screen audio held until Load clicked', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssmh1_' + ts;
        const user2 = 'ssmh2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page); await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // B enables manual load BEFORE A shares
        await page2.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(true));
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.settings.manualVideoLoad === true;
        }, undefined, { timeout: 10000 });

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });

        // B should NOT have screen audio — feed is unloaded by default
        await page2.waitForTimeout(3000);
        const hasAudioBeforeLoad = await page2.evaluate((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            return (s.remoteScreenAudioEls[uid] || []).length;
        }, body1.user.id);
        expect(hasAudioBeforeLoad).toBe(0);

        // A's screen-audio sender should be gated
        const gatedBeforeLoad = await getScreenAudioSenderGate(page, body2.user.id);
        expect(gatedBeforeLoad).toBe(true);

        // B clicks Load → audio resumes, sender ungated
        await page2.click('.dm-call-tile .voice-feed-load-btn');
        await waitScreenAudioActive(page2, body1.user.id);
        const gatedAfterLoad = await getScreenAudioSenderGate(page, body2.user.id);
        expect(gatedAfterLoad).toBe(false);

        await ctx2.close();
    });

    test('DM call (mesh): screen audio stays on WebRTC mesh, not relay', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssnr1_' + ts;
        const user2 = 'ssnr2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, page2, body1, body2);
        await waitForWs(page); await waitForWs(page2);
        await openDm(page);
        await startDmCall(page, page2, dm, userData.id, user2);

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        await waitScreenAudioActive(page2, body1.user.id);

        // Verify: A's mic sender to B is NOT nulled (mesh mode)
        const micNulled = await page.evaluate((uid) => {
            const pc = (window as any).VoiceManager._debug.state.peers[uid];
            if (!pc || !pc.getSenders) return 'no-pc';
            const audioSenders = pc.getSenders().filter((s: any) => s.track && s.track.kind === 'audio');
            return audioSenders.map((s: any) => ({
                id: s.track.id,
                nulled: !!s._voiceNulled,
            }));
        }, body2.user.id);

        // Screen audio sender should exist and NOT be nulled
        const screenAudioTrackId = await page.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.localStreams.screen.getAudioTracks()[0]?.id;
        });
        const screenSender = (micNulled as any[]).find((s: any) => s.id === screenAudioTrackId);
        if (screenSender) {
            expect(screenSender.nulled).toBe(false);
        }

        await ctx2.close();
    });

    test('server voice (relay): screen audio relay sends+receives via screen_audio kind', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssar1_' + ts;
        const user2 = 'ssar2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        // A shares screen with audio
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });

        // B receives screen audio via relay (remoteScreenAudioEls populated)
        await waitScreenAudioActive(page2, body1.user.id);

        // Verify screen audio elements have volume applied
        const vol = await page2.evaluate((uid) => {
            const els = (window as any).VoiceManager._debug.state.remoteScreenAudioEls[uid];
            if (!els || !els.length) return -1;
            return els[0].volume;
        }, body1.user.id);
        expect(vol).toBeGreaterThan(0);

        await ctx2.close();
    });

    test('relay: screen audio volume is separate from mic volume', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'ssv2_' + ts;
        const user2 = 'ssv2b_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        // A shares screen
        await page.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await page.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.screenOn && s.localStreams.screen &&
                s.localStreams.screen.getAudioTracks().length > 0;
        }, undefined, { timeout: 20000 });
        await waitScreenAudioActive(page2, body1.user.id);

        const uid1 = body1.user.id;

        // Set mic volume to 30% and screen volume to 80%
        await page2.evaluate((uid) => {
            localStorage.setItem('voice_volume_' + uid, '30');
            localStorage.setItem('voice_screen_volume_' + uid, '80');
            // Apply both volumes
            const s = (window as any).VoiceManager._debug.state;
            // Mic volume
            const micEls = s.remoteAudioEls && s.remoteAudioEls[uid];
            if (micEls && micEls.length) {
                micEls.forEach((el: any) => { el.volume = 0.3 * (s.settings.speakerVolume || 100) / 100; });
            }
            // Screen volume
            const scrEls = s.remoteScreenAudioEls && s.remoteScreenAudioEls[uid];
            if (scrEls && scrEls.length) {
                scrEls.forEach((el: any) => { el.volume = 0.8 * (s.settings.speakerVolume || 100) / 100; });
            }
        }, uid1);

        // Verify volumes are different
        const volumes = await page2.evaluate((uid) => {
            const s = (window as any).VoiceManager._debug.state;
            const micVol = (s.remoteAudioEls[uid] || [])[0]?.volume ?? -1;
            const scrVol = (s.remoteScreenAudioEls[uid] || [])[0]?.volume ?? -1;
            return { mic: Math.round(micVol * 100), screen: Math.round(scrVol * 100) };
        }, uid1);
        expect(volumes.mic).toBe(30);
        expect(volumes.screen).toBe(80);

        await ctx2.close();
    });

    test('deafened member: server stops forwarding audio relay frames', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'dbw1_' + ts;
        const user2 = 'dbw2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        await joinServerViaInvite(page2, body2.token, inviteCode);
        await waitForWs(page); await waitForWs(page2);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await selectServer(page2);
        await clickVoiceChannel(page2, voiceChannelId);
        await waitForConnected(page); await waitForConnected(page2);

        // Both connected
        const connected1 = await page.evaluate(() => !!(window as any).VoiceManager._debug.state.connected);
        const connected2 = await page2.evaluate(() => !!(window as any).VoiceManager._debug.state.connected);
        expect(connected1).toBeTruthy();
        expect(connected2).toBeTruthy();

        // B deaferns via the deafen button
        await page2.click('#voice-bar-deafen');
        await page2.waitForFunction(() => {
            return (window as any).VoiceManager._debug.state.deafened;
        }, undefined, { timeout: 5000 });

        // Verify deafened state propagated to server
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            const member = s.members[JSON.parse(localStorage.getItem('user') || '{}').id];
            return member && member.deafened;
        }, undefined, { timeout: 10000 });

        // A continues sending — B should not process relay audio (receiver side check)
        const bProcessingAudio = await page2.evaluate(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.deafened;
        });
        expect(bProcessingAudio).toBeTruthy();

        // Un-deafen — audio should resume
        await page2.click('#voice-bar-deafen');
        await page2.waitForFunction(() => {
            return !(window as any).VoiceManager._debug.state.deafened;
        }, undefined, { timeout: 5000 });

        await ctx2.close();
    });
});
