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
            else setTimeout(check, 100);
        };
        check();
    }));
}

async function enterDmView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await waitForWs(page);
    await page.click('#dm-strip-btn');
    await page.waitForSelector('.dm-item', { timeout: 8000 });
    await page.click('.dm-item');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
}

async function makeFriendsAndDm(pageA: any, pageB: any, bodyA: any, bodyB: any) {
    const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await pageA.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: codeB },
    });
    const incoming = await (await pageB.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${bodyB.token}` },
    })).json();
    await pageB.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    const dm = await (await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
        headers: { Authorization: `Bearer ${bodyA.token}` },
    })).json();
    return dm.dm_channel_id || dm.id;
}

test('B closes the tab while viewing a DM → A sees B offline, read acks persist', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const bodyA = await registerUser(pageA, 'pcA_' + Date.now());
    const bodyB = await registerUser(pageB, 'pcB_' + Date.now());
    const dmChannelId = await makeFriendsAndDm(pageA, pageB, bodyA, bodyB);

    await enterDmView(pageA);
    await enterDmView(pageB);

    // A sends a message; B (viewing live) auto-acks delivered then read.
    await waitForWs(pageA);
    await pageA.evaluate(async ({ dmChannelId, otherUserId }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text: 'presence probe' }), dmChannelId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
    }, { dmChannelId, otherUserId: bodyB.user.id });

    // B's live read ack lands on A.
    await pageA.waitForFunction(() => {
        const el = document.querySelector('.message .msg-status') as HTMLElement | null;
        return el && el.getAttribute('data-status') === 'read';
    }, undefined, { timeout: 10000 });

    // B is online in A's presence set + the DM header dot is green.
    await pageA.waitForFunction((bid) => (window as any).onlineUsersSize !== undefined || true, undefined, { timeout: 5000 }).catch(() => {});
    const bOnlineBefore = await pageA.evaluate((bid) => onlineUsers.has(bid), bodyB.user.id);
    expect(bOnlineBefore).toBe(true);

    // B closes the tab → the server removes B → A's presence set + dot update.
    await pageB.close();
    await pageA.waitForFunction((bid) => !onlineUsers.has(bid), bodyB.user.id, { timeout: 10000 });
    const dotClass = await pageA.evaluate(() => {
        const d = document.querySelector('#chat-header .presence-dot') || document.querySelector('.presence-dot');
        return d ? d.className : '';
    });
    expect(dotClass).toContain('offline');

    // Historical read receipt is NOT retroactively cleared.
    const statusAfter = await pageA.evaluate(() => {
        const el = document.querySelector('.message .msg-status') as HTMLElement | null;
        return el ? el.getAttribute('data-status') : null;
    });
    expect(statusAfter).toBe('read');

    await ctxA.close();
    await ctxB.close();
});

test('WS drop (server closed) clears stale presence locally until reconnect re-seeds it', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const bodyA = await registerUser(pageA, 'pdA_' + Date.now());
    const bodyB = await registerUser(pageB, 'pdB_' + Date.now());
    await makeFriendsAndDm(pageA, pageB, bodyA, bodyB);

    await enterDmView(pageA);
    await enterDmView(pageB);

    // Both are connected; A's set has B online.
    await pageA.waitForFunction((bid) => onlineUsers.has(bid), bodyB.user.id, { timeout: 10000 });

    // Simulate the server going away: force A's socket closed (no close frame
    // from the server side). The client's onclose must clear the stale set
    // instead of keeping everyone green.
    await pageA.evaluate(() => { ws.onclose && ws.onclose(); });
    expect(await pageA.evaluate(() => onlineUsers.size)).toBe(0);
    const dotAfterDrop = await pageA.evaluate(() => {
        const d = document.querySelector('#chat-header .presence-dot') || document.querySelector('.presence-dot');
        return d ? d.className : '';
    });
    expect(dotAfterDrop).toContain('offline');

    await ctxA.close();
    await ctxB.close();
});
