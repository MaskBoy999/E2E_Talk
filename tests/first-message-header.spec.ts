import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
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

async function enterChannelView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
    await waitForWs(page);
}

async function createServerAndKey(page: any, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const encName = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Header Test Server', key),
            encChName: E2ECrypto.encryptMessage('general', key),
        };
    });
    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: encName.encName.ciphertext,
            name_nonce: encName.encName.nonce,
            channel_encrypted_name: encName.encChName.ciphertext,
            channel_name_nonce: encName.encChName.nonce,
        },
    });
    const server = await res.json();
    await page.evaluate(async ({ serverId, userId, keyB64 }: { serverId: string; userId: string; keyB64: string }) => {
        const serverKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId, keyB64: encName.keyB64 });
    const channels = await (await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    })).json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

async function joinServerAndLoadKey(ownerPage: any, userPage: any, ownerToken: string, serverId: string, inviteCode: string, otherUserId: string) {
    const joinRes = await userPage.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${userPage.token}` },
        data: { code: inviteCode },
    });
    expect(joinRes.ok()).toBe(true);
    const otherPub = await userPage.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    await ownerPage.evaluate(async ({ serverId, otherUserId, otherPub }: { serverId: string; otherUserId: string; otherPub: string }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPub));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: otherUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId, otherUserId, otherPub });
    const ok = await userPage.evaluate(async ({ serverId }: { serverId: string }) => {
        return typeof fetchAndDecryptServerKey === 'function' ? await fetchAndDecryptServerKey(serverId) : false;
    }, { serverId });
    expect(ok).toBe(true);
}

// Send a real-UI message (types + Enter so the profile snapshot and encrypted
// sender username ride along, exactly like a real user's first message).
async function sendViaUi(page: any, text: string) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForFunction((t) => {
        const els = Array.from(document.querySelectorAll('.message .message-content-text, .message'));
        return els.some((e) => (e.textContent || '').includes(t));
    }, text, { timeout: 8000 });
}

// Read the header state of the FIRST rendered message.
async function firstMessageHeader(page: any) {
    return await page.evaluate(() => {
        const m = document.querySelector('.message') as HTMLElement | null;
        if (!m) return { found: false };
        const dn = m.querySelector('.display-name');
        const av = m.querySelector('.avatar');
        return {
            found: true,
            grouped: m.classList.contains('grouped'),
            displayName: dn ? (dn.textContent || '').trim() : null,
            avatarImg: !!av && !!av.querySelector('img'),
            avatarText: av ? (av.textContent || '').trim() : null,
        };
    });
}

// Poll A's message statuses until all own messages are 'read' (or timeout).
async function waitAllRead(page: any, timeoutMs: number): Promise<string> {
    return await page.evaluate((tmo) => new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const els = Array.from(document.querySelectorAll('.message .msg-status'));
            const statuses = els.map((e) => e.getAttribute('data-status'));
            if (els.length > 0 && statuses.every((s) => s === 'read')) { clearInterval(iv); resolve('read'); }
            else if (Date.now() - start > tmo) { clearInterval(iv); resolve('stuck:' + statuses.join(',')); }
        }, 250);
    }), timeoutMs);
}

test.describe('First-message header + read-ack fixes', () => {

    test('channel: first message shows pfp + display name after a reload', async ({ browser }) => {
        test.setTimeout(120000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'fhca_' + Date.now();
        const uB = 'fhcb_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        await enterChannelView(pageA);
        await sendViaUi(pageA, 'first channel message');
        await pageA.waitForTimeout(1500);

        // B opens the channel fresh (auto-select + click = the double-load that
        // used to group the first message and hide its header) and inspects the
        // first message.
        await enterChannelView(pageB);
        await pageB.waitForFunction(() => document.querySelectorAll('.message').length > 0, undefined, { timeout: 8000 });
        await pageB.waitForTimeout(1500);
        const info = await firstMessageHeader(pageB);
        expect(info.found).toBe(true);
        expect(info.grouped).toBe(false);
        expect(info.displayName).toBe(uA);
        // Header must be VISIBLE (not display:none from the grouped class).
        const headerVisible = await pageB.evaluate(() => {
            const dn = document.querySelector('.message .display-name') as HTMLElement | null;
            return dn ? getComputedStyle(dn.parentElement as HTMLElement).display !== 'none' : false;
        });
        expect(headerVisible).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });

    test('channel: B viewing + then returning to the tab marks messages read without a reload', async ({ browser }) => {
        test.setTimeout(120000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'fhda_' + Date.now();
        const uB = 'fhdB_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);

        // B opens the channel FIRST (already viewing), A then sends.
        await enterChannelView(pageB);
        await enterChannelView(pageA);
        await sendViaUi(pageA, 'message while B is looking');
        await pageA.waitForFunction(() => document.querySelector('.message .msg-status'), undefined, { timeout: 8000 });
        expect(await waitAllRead(pageA, 8000)).toBe('read');

        // B "leaves" the tab (document.hidden) — a new message must NOT be
        // marked read while hidden, then MUST be marked read when B returns
        // (visibilitychange re-ack), all without a reload.
        await pageB.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
        await sendViaUi(pageA, 'message while B is away');
        await pageA.waitForTimeout(1200); // past scheduleReadAck's 600ms delay
        const whileHidden = await pageA.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.message .msg-status'));
            return els.map((e) => e.getAttribute('data-status')).join(',');
        });
        expect(whileHidden).toContain('delivered'); // never a false read while hidden

        await pageB.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
        await pageB.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        expect(await waitAllRead(pageA, 8000)).toBe('read');

        await ctxA.close();
        await ctxB.close();
    });

    test('DM: first message header renders after a reload', async ({ browser }) => {
        test.setTimeout(120000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'fh_ma_' + Date.now();
        const uB = 'fh_mb_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

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
        await pageA.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        });

        await enterDmView(pageA);
        await sendViaUi(pageA, 'first dm message');
        await pageA.waitForTimeout(1500);

        await enterDmView(pageB);
        await pageB.waitForFunction(() => document.querySelectorAll('.message').length > 0, undefined, { timeout: 8000 });
        await pageB.waitForTimeout(1500);
        const info = await firstMessageHeader(pageB);
        expect(info.found).toBe(true);
        expect(info.grouped).toBe(false);
        expect(info.displayName).toBe(uA);

        await ctxA.close();
        await ctxB.close();
    });
});
