import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera.
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

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'MP' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Mirror Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('general', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { serverId: 'pending', inviteCode });

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
    await page.evaluate(async ({ serverId }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId });

    const serverKeyB64 = await page.evaluate((sid) => {
        const sk = E2ECrypto.getServerKey(sid);
        return E2ECrypto.arrayBufferToBase64(sk);
    }, serverId);
    const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
        const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
        const enc = E2ECrypto.aeadEncrypt(name, sk);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    }, { name: 'Mirror Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Mirror Voice',
            encrypted_name: encName2.ciphertext,
            name_nonce: encName2.nonce,
            channel_type: 'voice',
        },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function selectServer(page: any) {
    await page.evaluate(() => {
        if (typeof loadServers === 'function') loadServers();
    }).catch(() => {});
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

async function clickMenuBtn(page: any, text: string) {
    const btn = page.locator('#volume-menu .volume-menu-view-btn', { hasText: text });
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
}

async function tileTransform(page: any, selector: string) {
    return await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el as HTMLElement).style.transform || '' : null;
    }, selector);
}

test.describe('per-viewer right-click mirror/rotate transforms', () => {

    test('DM call: B mirrors + rotates A\'s camera and screen tiles (mirror stays horizontal under rotation)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'mip1_' + ts;
        const user2 = 'mip2_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);

        await setupFriends(page, page2, body1, body2);
        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();

        await waitForWs(page);
        await waitForWs(page2);
        await openDm(page);

        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        }, undefined, { timeout: 20000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.state && v._debug.state.connected;
        }, undefined, { timeout: 20000 });
        const aUid = body1.user.id;

        // A turns camera + screen on
        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });
        await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.screenOn;
        }, undefined, { timeout: 15000 });

        const camSel = `.dm-call-tile[data-uid="${aUid}"] video[data-kind="camera"]`;
        const scrSel = `.dm-call-tile[data-uid="${aUid}"] video[data-kind="screen"]`;

        // B right-clicks A's CAMERA tile → volume menu with the View section
        const camTile = page2.locator(camSel);
        await camTile.waitFor({ state: 'visible', timeout: 15000 });
        await camTile.click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        await page2.waitForSelector('.volume-menu-view-label', { state: 'visible', timeout: 5000 });
        expect(await page2.evaluate(() => document.querySelector('.volume-menu-view-label')!.textContent)).toBe('View');
        // A CAMERA feed carries no audio — its menu must show NO volume meter
        // (header says "Camera — …", and there is no slider / custom input).
        const camMenu = await page2.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return {
                header: m.querySelector('.volume-menu-header')!.textContent,
                hasSlider: !!m.querySelector('.volume-menu-slider'),
                hasCustom: !!m.querySelector('.volume-menu-custom-input'),
            };
        });
        expect(camMenu.header).toContain('Camera');
        expect(camMenu.hasSlider).toBe(false);
        expect(camMenu.hasCustom).toBe(false);

        // Mirror → horizontal flip only
        await clickMenuBtn(page2, '⇋ Mirror');
        expect(await tileTransform(page2, camSel)).toBe('scaleX(-1)');

        // Rotate right → mirror stays horizontal: scaleX(-1) rotate(90deg)
        await clickMenuBtn(page2, '⟳ 90°');
        expect(await tileTransform(page2, camSel)).toBe('scaleX(-1) rotate(90deg)');

        // Rotate right again → 180°
        await clickMenuBtn(page2, '⟳ 90°');
        expect(await tileTransform(page2, camSel)).toBe('scaleX(-1) rotate(180deg)');

        // Rotate LEFT back to 90° → still mirrored horizontally
        await clickMenuBtn(page2, '⟲ 90°');
        expect(await tileTransform(page2, camSel)).toBe('scaleX(-1) rotate(90deg)');

        // Reset clears everything
        await clickMenuBtn(page2, '↺ Reset');
        expect(await tileTransform(page2, camSel)).toBe('');

        // SCREEN tile transform is independent (own key): rotate only
        await page2.locator(scrSel).click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        // Screen share DOES carry audio — its menu must show the volume meter.
        expect(await page2.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return !!m.querySelector('.volume-menu-slider');
        })).toBe(true);
        await clickMenuBtn(page2, '⟳ 90°');
        expect(await tileTransform(page2, scrSel)).toBe('rotate(90deg)');
        // Camera tile was reset and must be unaffected
        expect(await tileTransform(page2, camSel)).toBe('');
        // Mirror on the screen tile → horizontal mirror + existing rotation
        await clickMenuBtn(page2, '⇋ Mirror');
        expect(await tileTransform(page2, scrSel)).toBe('scaleX(-1) rotate(90deg)');

        // A's OWN page is never affected (transform is viewer-local)
        const aCam = await tileTransform(page, camSel.replace('.dm-call-tile[data-uid="' + aUid + '"]', '.dm-call-tile[data-uid="' + body2.user.id + '"]'));
        expect(aCam).toBe('');
    });

    test('server voice channel: B mirrors A\'s camera tile in the popup rows', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'mip3_' + ts;
        const user2 = 'mip4_' + ts;

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await mockMedia(page);
        await mockMedia(page2);
        const body1 = await registerUser(page, user1);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
        const body2 = await registerUser(page2, user2);

        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2500);
        await waitForWs(page);
        await waitForWs(page2);

        expect(await selectServer(page)).toBe(true);
        expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
        await page.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 20000 });
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await page2.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected;
        }, undefined, { timeout: 20000 });
        const aUid = body1.user.id;

        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.waitForFunction(() => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.cameraOn;
        }, undefined, { timeout: 15000 });
        // B must actually receive A's camera stream before the tile gets size
        await page2.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.remoteStreams[uid] && !!s.remoteStreams[uid].camera;
        }, aUid, { timeout: 20000 });
        // Open the voice channel VIEW on B's side (the popup with member rows)
        await page2.evaluate(() => { window.VoiceManager.navigateToVoiceChannel(); });
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });

        const rowSel = `.voice-member-row[data-uid="${aUid}"] video[data-kind="camera"]`;
        const tile = page2.locator(rowSel);
        await tile.waitFor({ state: 'visible', timeout: 15000 });
        await tile.click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        await page2.waitForSelector('.volume-menu-view-label', { state: 'visible', timeout: 5000 });
        // Camera tile menu: video only — no volume meter (no camera audio).
        const srvCamMenu = await page2.evaluate(() => {
            const m = document.getElementById('volume-menu')!;
            return {
                hasSlider: !!m.querySelector('.volume-menu-slider'),
                hasCustom: !!m.querySelector('.volume-menu-custom-input'),
                header: m.querySelector('.volume-menu-header')!.textContent,
            };
        });
        expect(srvCamMenu.hasSlider).toBe(false);
        expect(srvCamMenu.hasCustom).toBe(false);
        expect(srvCamMenu.header).toContain('Camera');

        // Mirror → rotate right → mirror stays horizontal
        await clickMenuBtn(page2, '⇋ Mirror');
        expect(await tileTransform(page2, rowSel)).toBe('scaleX(-1)');
        await clickMenuBtn(page2, '⟳ 90°');
        expect(await tileTransform(page2, rowSel)).toBe('scaleX(-1) rotate(90deg)');
        await clickMenuBtn(page2, '↺ Reset');
        expect(await tileTransform(page2, rowSel)).toBe('');
    });
});
