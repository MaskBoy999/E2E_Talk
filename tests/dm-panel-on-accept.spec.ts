import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function createDm(page: any, body1: any, body2: any) {
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
    await page.waitForFunction(() => typeof viewMode !== 'undefined' && viewMode === 'dms', undefined, { timeout: 10000 });
}

// Create a server so the callee can be in a server-channel view (not the DM).
async function createServerForView(page: any, token: string): Promise<{ serverId: string }> {
    const ts = Date.now();
    const inviteCode = 'DPA' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey('pending', symKey);
        const encName = E2ECrypto.aeadEncrypt('PanelServer', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            invite_code: inviteCode,
            key: E2ECrypto.arrayBufferToBase64(symKey),
        };
    }, { inviteCode });
    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name,
            name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.encrypted_name,
            channel_name_nonce: prep.name_nonce,
        },
    })).json();
    const serverId = srv.id;
    await page.evaluate(async ({ serverId, key }) => {
        const symKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(key));
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
    }, { serverId, key: prep.key });
    return { serverId };
}

async function goToServerView(page: any) {
    await page.evaluate(() => { if (typeof loadServers === 'function') loadServers(); }).catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
        if (count > 0) {
            await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
            await page.waitForTimeout(600);
            break;
        }
        await page.waitForTimeout(300);
    }
    await page.waitForFunction(() => typeof viewMode !== 'undefined' && viewMode === 'servers', undefined, { timeout: 10000 });
}

async function panelSnap(page: any) {
    return await page.evaluate(() => {
        const v = window.VoiceManager;
        const p = document.getElementById('dm-call-panel');
        const mb = document.getElementById('dm-mini-bar');
        return {
            dmCallActive: v._debug.state.dmCallActive,
            dmCallAnswered: v._debug.state.dmCallAnswered,
            viewMode: typeof viewMode !== 'undefined' ? viewMode : null,
            curDm: typeof currentDmChannelId !== 'undefined' ? currentDmChannelId : null,
            panelDisplay: p ? p.style.display : null,
            miniBarDisplay: mb ? mb.style.display : null,
        };
    });
}

test.describe('DM call panel appears immediately on accept/join', () => {

    test('ACCEPT from a server view switches to the DM and shows the panel', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'pa1_' + ts;
        const user2 = 'pa2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        // Callee (page2) navigates to a server view so it is NOT in the DM
        await createServerForView(page2, body2.token);
        await goToServerView(page2);

        // Caller starts the call
        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user1 });

        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

        // Accept via the real UI button
        await page2.click('#incoming-call-accept');
        await page2.waitForTimeout(2500);

        const s = await panelSnap(page2);
        console.log('[DM-PANEL] accept-from-server:', JSON.stringify(s));
        expect(s.dmCallActive).toBe(true);
        expect(s.dmCallAnswered).toBe(true);
        // The view must have switched to the DM conversation…
        expect(s.viewMode).toBe('dms');
        expect(s.curDm).toBe(dm.id);
        // …and the call panel is visible (mini bar hidden).
        expect(s.panelDisplay).toBe('flex');
        expect(s.miniBarDisplay).toBe('none');
    });

    test('ACCEPT while already in the DM view shows the panel immediately', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'pb1_' + ts;
        const user2 = 'pb2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        // Callee opens the DM conversation view
        await openDm(page2);

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user1 });

        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

        await page2.click('#incoming-call-accept');
        await page2.waitForTimeout(1500);

        const s = await panelSnap(page2);
        console.log('[DM-PANEL] accept-in-dm-view:', JSON.stringify(s));
        expect(s.dmCallActive).toBe(true);
        expect(s.viewMode).toBe('dms');
        expect(s.curDm).toBe(dm.id);
        expect(s.panelDisplay).toBe('flex');
        expect(s.miniBarDisplay).toBe('none');
    });

    test('DECLINE then JOIN from the waiting banner shows the panel immediately', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'pc1_' + ts;
        const user2 = 'pc2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page2);

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user1 });

        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

        // Decline -> caller waits, callee sees the waiting banner
        await page2.click('#incoming-call-decline');
        await page2.waitForFunction(() => {
            const b = document.getElementById('dm-waiting-banner');
            return b && b.style.display === 'flex';
        }, undefined, { timeout: 15000 });

        // Join from the banner
        await page2.click('#dm-waiting-join-btn');
        await page2.waitForTimeout(2500);

        const s = await panelSnap(page2);
        console.log('[DM-PANEL] join-from-banner:', JSON.stringify(s));
        expect(s.dmCallActive).toBe(true);
        expect(s.viewMode).toBe('dms');
        expect(s.curDm).toBe(dm.id);
        expect(s.panelDisplay).toBe('flex');
        expect(s.miniBarDisplay).toBe('none');
    });

    test('RING TIMEOUT then JOIN from the waiting bar while in a server view switches to the DM', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'pd1_' + ts;
        const user2 = 'pd2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        // Callee navigates to a server view so it is NOT in the DM
        await createServerForView(page2, body2.token);
        await goToServerView(page2);

        // Shorten the ring so the 30s timeout runs fast
        await page2.evaluate(() => window.VoiceManager.setRingTimeoutMs(1500));

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user1 });

        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });

        // Let the ring time out -> the incoming bar flips to the waiting state
        // ("Join") WITHOUT a decline.
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v.isIncomingWaiting();
        }, undefined, { timeout: 15000 });

        // Join via the waiting incoming bar's Accept (= Join) button
        await page2.click('#incoming-call-accept');
        await page2.waitForTimeout(2500);

        const s = await panelSnap(page2);
        console.log('[DM-PANEL] join-from-server:', JSON.stringify(s));
        expect(s.dmCallActive).toBe(true);
        expect(s.viewMode).toBe('dms');
        expect(s.curDm).toBe(dm.id);
        expect(s.panelDisplay).toBe('flex');
        expect(s.miniBarDisplay).toBe('none');
    });

    test('joinWaitingCall from a server view switches to the DM and shows the panel', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'pe1_' + ts;
        const user2 = 'pe2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        // Callee navigates to a server view so it is NOT in the DM
        await createServerForView(page2, body2.token);
        await goToServerView(page2);

        // Directly join the waiting room (as the callee would via the mutual
        // callback / waiting-marker join) while still in the server view.
        await page2.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.joinWaitingCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user1 });
        await page2.waitForTimeout(2500);

        const s = await panelSnap(page2);
        console.log('[DM-PANEL] joinWaitingCall-from-server:', JSON.stringify(s));
        expect(s.dmCallActive).toBe(true);
        expect(s.viewMode).toBe('dms');
        expect(s.curDm).toBe(dm.id);
        expect(s.panelDisplay).toBe('flex');
        expect(s.miniBarDisplay).toBe('none');
    });
});
