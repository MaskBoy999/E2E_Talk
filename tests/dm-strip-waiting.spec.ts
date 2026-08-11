import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// --- Shared helpers (mirror voice-call-from-channel.spec.ts) ---

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
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

async function createServerForB(page: any, page2: any, tokenA: string, tokenB: string) {
    // A creates a server (encrypted name + a text channel), uploads the server
    // key envelope, then B joins via invite so B has a non-DM view to browse.
    // Mirrors createServerWithVoiceChannel from voice-call-from-channel.spec.ts.
    const ts = Date.now();
    const inviteCode = 'SW' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey('pending-sw', symKey);
        const encName = E2ECrypto.aeadEncrypt('StripServer', symKey);
        const encCh = E2ECrypto.aeadEncrypt('general', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });
    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name,
            name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.channel_encrypted_name,
            channel_name_nonce: prep.channel_name_nonce,
        },
    })).json();
    const serverId = srv.id;
    // Save the key under the REAL server id + upload the envelope so the
    // invitee (B) can fetch-and-decrypt it later.
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
    const join = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();
    return serverId;
}

async function goToServerView(page: any) {
    // Click the DM button (harmless anywhere) then a server icon → server view.
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

async function stripState(page: any) {
    return await page.evaluate(() => {
        const el = document.getElementById('dm-strip-waiting') as HTMLElement;
        if (!el) return { exists: false, visible: false, calling: false, title: '' };
        return {
            exists: true,
            visible: el.style.display !== 'none',
            calling: el.classList.contains('calling'),
            title: el.title,
        };
    });
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

async function startCallAndDecline(page: any, page2: any, dm: any, userData: any, user2: string) {
    await waitForWs(page);
    await waitForWs(page2);
    await page.evaluate(() => window.VoiceManager.setRingTimeoutMs(5000));
    await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(5000));
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 10000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: user2 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug.state.incomingCall !== null;
    }, undefined, { timeout: 15000 });
    await page2.evaluate(() => window.VoiceManager.declineDmCall());
    // Callee's persisted waiting marker is set (caller is waiting).
    await page2.waitForFunction((dmId) => {
        const v = window.VoiceManager;
        return v && v.getWaitingCall && !!v.getWaitingCall(dmId);
    }, dm.id, { timeout: 15000 });
}

test.describe('DM-strip waiting/calling indicator (visible from anywhere)', () => {

    test('waiting call shows on the DM strip from a server view and clears when joined', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const userA = 'swa1_' + ts;
        const userB = 'swb1_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        const serverId = await createServerForB(page1, page2, bodyA.token, bodyB.token);
        expect(serverId).toBeTruthy();
        await setupFriends(page1, page2, bodyA, bodyB);
        const { userData, dm } = await createDm(page1, page2, bodyA, bodyB);

        await page1.goto(`${BASE}/index.html`);
        await page1.waitForTimeout(2000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await waitForWs(page1);
        await waitForWs(page2);

        await startCallAndDecline(page1, page2, dm, userData, userB);

        // Callee B navigates to the SERVER view — the strip indicator must
        // still be visible there (the sidebar dot is only visible in DM view).
        expect(await goToServerView(page2)).toBe(true);
        await page2.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none';
        }, undefined, { timeout: 10000 });

        const sWaiting = await stripState(page2);
        expect(sWaiting.exists).toBe(true);
        expect(sWaiting.visible).toBe(true);
        expect(sWaiting.calling).toBe(false); // amber = waiting, not ringing
        expect(sWaiting.title).toBe('Call waiting');

        // In server view the sidebar shows channels, NOT the DM row dot — the
        // strip is the only waiting indicator visible here.
        expect(await page2.locator('.dm-waiting-dot').count()).toBe(0);

        // B joins the waiting call → indicator disappears.
        await openDm(page2);
        const joinVisible = await page2.locator('#dm-waiting-join-btn').isVisible().catch(() => false);
        expect(joinVisible).toBeTruthy();
        await page2.locator('#dm-waiting-join-btn').click();
        await page1.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isConnected() && v.isInDmCall();
        }, undefined, { timeout: 20000 });

        const sGone = await stripState(page2);
        expect(sGone.visible).toBe(false);

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });

    test('ringing call shows the GREEN calling indicator from a server view, then flips to waiting on decline', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const userA = 'swa2_' + ts;
        const userB = 'swb2_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        const serverId = await createServerForB(page1, page2, bodyA.token, bodyB.token);
        expect(serverId).toBeTruthy();
        await setupFriends(page1, page2, bodyA, bodyB);
        const { userData, dm } = await createDm(page1, page2, bodyA, bodyB);

        await page1.goto(`${BASE}/index.html`);
        await page1.waitForTimeout(2000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await waitForWs(page1);
        await waitForWs(page2);

        // B goes to the server view FIRST, then A rings B.
        expect(await goToServerView(page2)).toBe(true);
        await page1.evaluate(() => window.VoiceManager.setRingTimeoutMs(8000));
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(8000));
        await page1.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 10000 });
        await page1.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: userB });

        // While B is in the server view, the ring must surface on the strip as
        // the green "calling" badge (callee side — incoming ring).
        await page2.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none' && el.classList.contains('calling');
        }, undefined, { timeout: 15000 });
        const sRingingB = await stripState(page2);
        expect(sRingingB.visible).toBe(true);
        expect(sRingingB.calling).toBe(true);
        expect(sRingingB.title).toBe('Call ringing');

        // The caller (A) also sees the green badge from a server view.
        expect(await goToServerView(page1)).toBe(true);
        await page1.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none' && el.classList.contains('calling');
        }, undefined, { timeout: 10000 });
        const sRingingA = await stripState(page1);
        expect(sRingingA.calling).toBe(true);

        // B declines → both strips flip to the amber waiting badge.
        await page2.evaluate(() => window.VoiceManager.declineDmCall());
        await page2.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none' && !el.classList.contains('calling') && el.title === 'Call waiting';
        }, undefined, { timeout: 15000 });
        const sWaitingB = await stripState(page2);
        expect(sWaitingB.calling).toBe(false);
        expect(sWaitingB.title).toBe('Call waiting');

        await page1.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none' && !el.classList.contains('calling') && el.title === 'Call waiting';
        }, undefined, { timeout: 15000 });
        const sWaitingA = await stripState(page1);
        expect(sWaitingA.calling).toBe(false);
        expect(sWaitingA.title).toBe('Call waiting');

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });

    test('waiting indicator persists on the strip across a page refresh', async ({ browser }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const userA = 'swa3_' + ts;
        const userB = 'swb3_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        const serverId = await createServerForB(page1, page2, bodyA.token, bodyB.token);
        expect(serverId).toBeTruthy();
        await setupFriends(page1, page2, bodyA, bodyB);
        const { userData, dm } = await createDm(page1, page2, bodyA, bodyB);

        await page1.goto(`${BASE}/index.html`);
        await page1.waitForTimeout(2000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await waitForWs(page1);
        await waitForWs(page2);

        await startCallAndDecline(page1, page2, dm, userData, userB);

        // B refreshes; the persisted marker must bring the strip indicator
        // back without opening the DM conversation.
        await page2.reload();
        await page2.waitForURL('**/index.html', { timeout: 15000 });
        await waitForWs(page2);
        expect(await goToServerView(page2)).toBe(true);
        await page2.waitForFunction(() => {
            const el = document.getElementById('dm-strip-waiting') as HTMLElement;
            return el && el.style.display !== 'none';
        }, undefined, { timeout: 20000 });
        const s = await stripState(page2);
        expect(s.visible).toBe(true);
        expect(s.calling).toBe(false);
        expect(s.title).toBe('Call waiting');

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });
});
