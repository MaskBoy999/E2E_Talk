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

// Create a server with a voice channel so the caller can start the call from a
// server view (the voice-channel member-row / chip 📞 entry point).
async function createServerWithVoice(page: any, token: string, name: string): Promise<{ serverId: string }> {
    await page.waitForFunction(() => typeof E2ECrypto !== 'undefined', undefined, { timeout: 15000 });
    const ts = Date.now();
    const inviteCode = 'SCV' + name + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey('pending', symKey);
        const encName = E2ECrypto.aeadEncrypt('CallServer', symKey);
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

    const chPrep = await page.evaluate(async ({ key }) => {
        const symKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(key));
        const encName = E2ECrypto.aeadEncrypt('Voice', symKey);
        return { encrypted_name: encName.ciphertext, name_nonce: encName.nonce };
    }, { key: prep.key });
    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            type: 'voice',
            encrypted_name: chPrep.encrypted_name,
            name_nonce: chPrep.name_nonce,
        },
    })).json();
    return { serverId, channelId: ch.id };
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

async function snap(page: any) {
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

test.describe('CALLER sees the DM call panel immediately when the callee accepts', () => {

    test('caller started the call from a server (voice-channel) view', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'csa_' + ts;
        const user2 = 'csb_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        // Caller is in a SERVER view (the callMemberFromVoice 📞 entry point)
        await createServerWithVoice(page, body1.token, user1);
        await goToServerView(page);

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForTimeout(1200);

        // Callee accepts via the real UI button
        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForTimeout(2500);

        const caller = await snap(page);
        const callee = await snap(page2);
        console.log('[CALLER-SIDE] caller-from-server:', JSON.stringify(caller), 'callee:', JSON.stringify(callee));

        // The CALLER must land in the DM view with the panel — no manual refresh.
        expect(caller.dmCallAnswered).toBe(true);
        expect(caller.viewMode).toBe('dms');
        expect(caller.curDm).toBe(dm.id);
        expect(caller.panelDisplay).toBe('flex');
        expect(caller.miniBarDisplay).toBe('none');
        // Callee unchanged (still the correct behavior).
        expect(callee.panelDisplay).toBe('flex');
    });

    test('caller was already in the DM view — panel stays up through the accept', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'cma_' + ts;
        const user2 = 'cmb_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        const body1 = await registerUser(page, user1);
        await setupFriends(page, page2, body1, body2);
        const { userData, dm } = await createDm(page, body1, body2);
        await waitForWs(page);
        await waitForWs(page2);

        await openDm(page);

        await page.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: user2 });
        await page.waitForTimeout(1200);

        await page2.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug.state.incomingCall !== null;
        }, undefined, { timeout: 15000 });
        await page2.click('#incoming-call-accept');
        await page2.waitForTimeout(2000);

        const caller = await snap(page);
        console.log('[CALLER-SIDE] caller-in-dm-view:', JSON.stringify(caller));
        expect(caller.dmCallAnswered).toBe(true);
        expect(caller.viewMode).toBe('dms');
        expect(caller.curDm).toBe(dm.id);
        expect(caller.panelDisplay).toBe('flex');
        expect(caller.miniBarDisplay).toBe('none');
    });
});
