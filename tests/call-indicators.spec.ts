import { test, expect } from '@playwright/test';

// E2E_TEST_BASE_URL lets the suite run against a second, isolated server
// instance (its own DB and raised rate limits) without disturbing a dev server.
const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

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
    return await page.evaluate(() => new Promise((resolve) => {
        let tries = 0;
        const check = () => {
            tries++;
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
            else if (tries >= 60) resolve(false);
            else setTimeout(check, 200);
        };
        setTimeout(check, 500);
    }));
}

async function setupFriends(pageA: any, pageB: any, bodyA: any, bodyB: any) {
    const fcB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcB },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyB.token}` },
    })).json();
    const acc = await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(pageA: any, bodyA: any, bodyB: any) {
    const userData = await (await pageA.request.get(`${BASE}/api/user/${bodyB.user.username}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    const dm = await (await pageA.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
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
    await page.waitForFunction(() => typeof viewMode !== 'undefined' && viewMode === 'dms', undefined, { timeout: 10000 });
}

async function goToServerView(page: any) {
    await page.evaluate(() => { if (typeof loadServers === 'function') loadServers(); }).catch(() => {});
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
        if (count > 0) {
            await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
            await page.waitForTimeout(600);
            const inSrv = await page.evaluate(() => (typeof viewMode !== 'undefined' && viewMode === 'servers'));
            if (inSrv) return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    await page.waitForFunction(() => typeof E2ECrypto !== 'undefined', undefined, { timeout: 15000 });
    const ts = Date.now();
    const inviteCode = 'CI' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey('pending', symKey);
        const encName = E2ECrypto.aeadEncrypt('Ind Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('General', symKey);
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
    }, { name: 'Ind Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Ind Voice',
            encrypted_name: encName2.ciphertext,
            name_nonce: encName2.nonce,
            channel_type: 'voice',
        },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
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

async function waitConnected(page: any, timeout = 30000) {
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v.isConnected && v.isConnected();
    }, undefined, { timeout });
}

async function fastRing(page: any) {
    await page.evaluate(() => {
        (window as any).VoiceManager.setRingTimeoutMs(1500);
    });
}

test.describe('call indicators (DM list, DM strip, server list)', () => {

    test('DM list: "waiting with them" (amber) vs "waiting for us" (red) are distinct on each side', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'ia1_' + ts;
        const userB = 'ib1_' + ts;
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        const bodyB = await registerUser(pageB, userB);
        const bodyA = await registerUser(page, userA);
        await setupFriends(page, pageB, bodyA, bodyB);
        const { userData, dm } = await createDm(page, bodyA, bodyB);
        await waitForWs(page);
        await waitForWs(pageB);
        await fastRing(page);
        await fastRing(pageB);

        // Both are in their DM view (sidebar rendered)
        await openDm(page);
        await openDm(pageB);

        // A calls B; B never answers → after the (short) ring timeout A flips
        // to "waiting for B" and B is told "A is waiting for you to join".
        await page.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: userB });
        await page.waitForTimeout(5000);

        // A's row for B: AMBER "waiting with them" — NOT red.
        const aAmber = await page.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-waiting-dot`).count();
        const aRed = await page.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`).count();
        console.log('[IND] A side amber:', aAmber, 'red:', aRed);
        expect(aAmber).toBe(1);
        expect(aRed).toBe(0);

        // B's row for A: RED "waiting for us" — NOT amber.
        await pageB.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`, { timeout: 15000 });
        const bRed = await pageB.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-for-us-dot`).count();
        const bAmber = await pageB.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-waiting-dot`).count();
        console.log('[IND] B side amber:', bAmber, 'red:', bRed);
        expect(bRed).toBe(1);
        expect(bAmber).toBe(0);

        // The connected state is a THIRD, distinct indicator: B joins → A's row
        // flips to the blue in-call mic.
        await pageB.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const inc = vm.getIncomingCall();
            if (inc) vm.acceptDmCall();
        });
        await page.waitForSelector(`.dm-item[data-dm-id="${dm.id}"] .dm-connected-dot`, { timeout: 20000 });
        const aConnected = await page.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-connected-dot`).count();
        const aAmber2 = await page.locator(`.dm-item[data-dm-id="${dm.id}"] .dm-waiting-dot`).count();
        console.log('[IND] A connected:', aConnected, 'amber after:', aAmber2);
        expect(aConnected).toBe(1);
        expect(aAmber2).toBe(0);
    });

    test('strip: in-call badge AND "waiting for us" badge show simultaneously', async ({ page, context }) => {
        test.setTimeout(150000);
        const ts = Date.now();
        const userA = 'ic1_' + ts;
        const userB = 'ic2_' + ts;
        const userC = 'ic3_' + ts;
        const ctxB = await context.browser()!.newContext();
        const ctxC = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        const pageC = await ctxC.newPage();
        const bodyB = await registerUser(pageB, userB);
        const bodyC = await registerUser(pageC, userC);
        const bodyA = await registerUser(page, userA);
        await setupFriends(page, pageB, bodyA, bodyB);
        await setupFriends(page, pageC, bodyA, bodyC);
        const { userData: bData, dm: dmB } = await createDm(page, bodyA, bodyB);
        const { userData: cData, dm: dmC } = await createDm(page, bodyA, bodyC);
        await waitForWs(page);
        await waitForWs(pageB);
        await waitForWs(pageC);
        await fastRing(page);
        await fastRing(pageC);

        // A is in the DM view so the sidebar is live
        await openDm(page);

        // A calls B; B accepts → A is in an ACTIVE call (blue connected badge)
        await page.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dmB.id, uid: bData.id, uname: userB });
        await pageB.waitForFunction(() => {
            const v = (window as any).VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 20000 });
        await pageB.click('#incoming-call-accept');
        await pageB.waitForTimeout(2000);
        await page.waitForSelector('#dm-strip-waiting.connected', { timeout: 20000 });

        // Now C calls A and A doesn't answer → C waits for us.
        await pageC.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dmC.id, uid: bodyA.user.id, uname: userA });
        await page.waitForTimeout(5000);

        const snap = await page.evaluate(() => {
            const active = document.getElementById('dm-strip-waiting') as HTMLElement;
            const forUs = document.getElementById('dm-strip-for-us') as HTMLElement;
            // The badges render inline SVG icons (icon('mic') / icon('phone')),
            // not emoji. Asserting on the sprite ids the badge actually
            // references proves the glyph a user sees — and would catch a badge
            // that silently renders nothing. (Comparing innerHTML instead is
            // fragile: the DOM serialises `<use/>` as `<use></use>`.)
            const iconIds = (el: HTMLElement | null) => el
                ? Array.from(el.querySelectorAll('svg.ui-icon use')).map((u) => u.getAttribute('href'))
                : [];
            return {
                activeVisible: active ? active.style.display !== 'none' : false,
                activeConnected: active ? active.classList.contains('connected') : false,
                activeIcons: iconIds(active),
                forUsVisible: forUs ? forUs.style.display !== 'none' : false,
                forUsIcons: iconIds(forUs),
            };
        });
        console.log('[IND] strip snap:', JSON.stringify(snap));
        // BOTH badges at once: we're in a call with B AND C is waiting for us.
        expect(snap.activeVisible).toBe(true);
        expect(snap.activeConnected).toBe(true);
        expect(snap.activeIcons).toEqual(['#icon-mic']);
        expect(snap.forUsVisible).toBe(true);
        expect(snap.forUsIcons).toEqual(['#icon-phone']);
        // The two badges must stay visually distinguishable (mic ≠ phone).
        expect(snap.activeIcons).not.toEqual(snap.forUsIcons);

        // The DM list mirrors both too: B's row = blue mic, C's row = red phone.
        await page.waitForSelector(`.dm-item[data-dm-id="${dmB.id}"] .dm-connected-dot`, { timeout: 15000 });
        await page.waitForSelector(`.dm-item[data-dm-id="${dmC.id}"] .dm-for-us-dot`, { timeout: 15000 });
        expect(await page.locator(`.dm-item[data-dm-id="${dmB.id}"] .dm-connected-dot`).count()).toBe(1);
        expect(await page.locator(`.dm-item[data-dm-id="${dmC.id}"] .dm-for-us-dot`).count()).toBe(1);
    });

    test('server list: live green dot when someone is in a voice channel, including yourself', async ({ page, context }) => {
        test.setTimeout(150000);
        const ts = Date.now();
        const userA = 'sv1_' + ts;
        const userB = 'sv2_' + ts;
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        await mockMedia(page);
        await mockMedia(pageB);
        const bodyA = await registerUser(page, userA);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, bodyA.token);
        const bodyB = await registerUser(pageB, userB);
        const join = await pageB.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();
        await waitForWs(page);
        await waitForWs(pageB);

        expect(await goToServerView(page)).toBe(true);
        expect(await goToServerView(pageB)).toBe(true);

        // No one in a voice channel yet → no dots
        await page.waitForTimeout(1500);
        expect(await page.locator(`.server-icon[data-id="${serverId}"] .server-voice-dot`).count()).toBe(0);

        // B joins the voice channel → the dot appears on BOTH sides live
        expect(await clickVoiceChannel(pageB, voiceChannelId)).toBe(true);
        await waitConnected(pageB);
        await page.waitForSelector(`.server-icon[data-id="${serverId}"] .server-voice-dot`, { timeout: 15000 });
        // "even own person" — B's own server icon lights up too
        await pageB.waitForSelector(`.server-icon[data-id="${serverId}"] .server-voice-dot`, { timeout: 15000 });
        console.log('[IND] voice dot visible on both sides');

        // B leaves → dot disappears on both sides live
        await pageB.evaluate(() => { (window as any).VoiceManager.leaveVoice(); });
        await page.waitForFunction((sid: string) => {
            const el = document.querySelector(`.server-icon[data-id="${sid}"] .server-voice-dot`);
            return !el;
        }, serverId, { timeout: 15000 });
        await pageB.waitForFunction((sid: string) => {
            const el = document.querySelector(`.server-icon[data-id="${sid}"] .server-voice-dot`);
            return !el;
        }, serverId, { timeout: 15000 });
        console.log('[IND] voice dot gone on both sides');
    });
});
