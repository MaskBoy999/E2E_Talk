import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

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

async function createServerAndKey(page: any, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const encName = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Disappear Test Server', key),
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

// Send a disappearing DM message (ttl_seconds = plaintext server-enforced TTL).
async function sendDmDisappearingViaWs(page: any, dmChannelId: string, otherUserId: string, text: string, ttl: number) {
    await waitForWs(page);
    return await page.evaluate(async ({ dmChannelId, otherUserId, text, ttl }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(JSON.stringify({ type: 'text', text }), dmChannelId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
            ttl_seconds: ttl,
        }));
        return 'sent';
    }, { dmChannelId, otherUserId, text, ttl });
}

async function sendChannelDisappearingViaWs(page: any, channelId: string, serverId: string, text: string, ttl: number, fileId?: string) {
    await waitForWs(page);
    return await page.evaluate(async ({ channelId, serverId, text, ttl, fileId }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(JSON.stringify({ type: 'text', text }), key);
        const payload: any = {
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
            ttl_seconds: ttl,
        };
        if (fileId) payload.file_id = fileId;
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { channelId, serverId, text, ttl, fileId });
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

async function enterDmView(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await waitForWs(page);
    await page.click('#dm-strip-btn');
    await page.waitForSelector('.dm-item', { timeout: 8000 });
    await page.click('.dm-item');
    await expect(page.locator('#message-input')).toBeEnabled({ timeout: 8000 });
}

// Upload a tiny file and return its raw file_id (for attachment shred tests).
async function uploadFile(page: any, token: string, bytes: number[]): Promise<string> {
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: bytes.length },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();
    await page.evaluate(async ({ fileId, bytes }) => {
        const key = E2ECrypto.generateFileKey();
        const encChunk = E2ECrypto.encryptFileChunk(key, new Uint8Array(bytes));
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: new Blob([encChunk], { type: 'application/octet-stream' }),
        });
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
    }, { fileId: file_id, bytes });
    return file_id;
}

test.describe('Disappearing messages (server-enforced TTL + shredding)', () => {

    test('DM: both members see the countdown; the server shreds the row and both clients remove it live', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'dsa_' + Date.now();
        const uB = 'dsa2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageA as any).token = bodyA.token;
        (pageB as any).token = bodyB.token;

        const codeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await pageA.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: codeB },
        });
        expect(fr.ok()).toBeTruthy();
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
        const dmChannelId = dm.dm_channel_id || dm.id;

        await enterDmView(pageA);
        await enterDmView(pageB);

        expect(await sendDmDisappearingViaWs(pageA, dmChannelId, bodyB.user.id, 'burn after reading', 5)).toBe('sent');

        // Both pages render the disappearing banner with a live countdown.
        await pageA.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        await pageB.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        const messageId = await pageA.evaluate(() => {
            const el = document.querySelector('.message[data-expires-at]') as HTMLElement | null;
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(messageId).toBeTruthy();

        // The banner label ticks down (e.g. 0:04 → 0:03), not frozen.
        const label1 = await pageA.evaluate(() => (document.querySelector('.disappearing-timer') as HTMLElement)?.textContent || '');
        await pageA.waitForTimeout(1100);
        const label2 = await pageA.evaluate(() => (document.querySelector('.disappearing-timer') as HTMLElement)?.textContent || '');
        expect(label1).toMatch(/^0:\d+$/);
        expect(label2).toMatch(/^0:\d+$/);
        expect(label2).not.toBe(label1);

        // After the TTL + sweep, the row is GONE from the DB (ciphertext shredded)
        // and both clients removed the message live via message_expired. The server
        // sweeper runs every ~5s, so poll the DB until the row actually disappears
        // (the client-side DOM removal can beat the next sweep tick by a few seconds).
        await pageA.waitForFunction((mid) => !document.querySelector(`.message[data-message-id="${mid}"]`), messageId, { timeout: 20000 });
        await pageB.waitForFunction((mid) => !document.querySelector(`.message[data-message-id="${mid}"]`), messageId, { timeout: 20000 });
        const dbGone = async () => {
            for (let i = 0; i < 20; i++) {
                const dbOut = execSync(
                    `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT COUNT(*) FROM dm_messages WHERE id=?', ('${messageId}',)).fetchone(); tok=con.execute('SELECT COUNT(*) FROM dm_message_search_tokens WHERE message_id=?', ('${messageId}',)).fetchone(); print(rows[0], tok[0])"`,
                    { encoding: 'utf-8' }
                ).trim();
                if (dbOut === '0 0') return dbOut;
                await new Promise((r) => setTimeout(r, 1000));
            }
            return execSync(
                `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT COUNT(*) FROM dm_messages WHERE id=?', ('${messageId}',)).fetchone(); tok=con.execute('SELECT COUNT(*) FROM dm_message_search_tokens WHERE message_id=?', ('${messageId}',)).fetchone(); print(rows[0], tok[0])"`,
                { encoding: 'utf-8' }
            ).trim();
        };
        expect(await dbGone()).toBe('0 0');

        await ctxA.close();
        await ctxB.close();
    });

    test('channel: disappearing message is shredded server-side and removed on every member', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();
        const uA = 'dsc_' + Date.now();
        const uB = 'dsc2_' + Date.now();
        const bodyA = await registerUser(pageA, uA);
        const bodyB = await registerUser(pageB, uB);
        (pageB as any).token = bodyB.token;
        const { serverId, channelId, inviteCode } = await createServerAndKey(pageA, bodyA.token, bodyA.user.id);
        await joinServerAndLoadKey(pageA, pageB, bodyA.token, serverId, inviteCode, bodyB.user.id);
        await enterChannelView(pageA);
        await enterChannelView(pageB);

        expect(await sendChannelDisappearingViaWs(pageA, channelId, serverId, 'this vanishes', 5)).toBe('sent');
        await pageA.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        await pageB.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        const messageId = await pageA.evaluate(() => {
            const el = document.querySelector('.message[data-expires-at]') as HTMLElement | null;
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(messageId).toBeTruthy();

        // A normal message sent alongside is NOT affected.
        expect(await sendChannelDisappearingViaWs(pageA, channelId, serverId, 'keep me', 0)).toBe('sent');
        await pageA.waitForSelector('.message', { timeout: 8000 });

        await pageA.waitForFunction((mid) => !document.querySelector(`.message[data-message-id="${mid}"]`), messageId, { timeout: 20000 });
        await pageB.waitForFunction((mid) => !document.querySelector(`.message[data-message-id="${mid}"]`), messageId, { timeout: 20000 });

        // Poll until the sweeper actually shreds the row (5s tick can lag the DOM removal).
        let dbOut = '1';
        for (let i = 0; i < 20 && dbOut !== '0'; i++) {
            dbOut = execSync(
                `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT COUNT(*) FROM messages WHERE id=?', ('${messageId}',)).fetchone(); print(rows[0])"`,
                { encoding: 'utf-8' }
            ).trim();
            if (dbOut !== '0') await new Promise((r) => setTimeout(r, 1000));
        }
        expect(dbOut).toBe('0');
        // The non-disappearing message is still there.
        const keepOut = execSync(
            `python3 -c "import sqlite3,sys; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT COUNT(*) FROM messages WHERE channel_id=? AND expires_at IS NULL', (sys.argv[1],)).fetchone(); print(rows[0])" ${channelId}`,
            { encoding: 'utf-8' }
        ).trim();
        expect(parseInt(keepOut, 10)).toBeGreaterThanOrEqual(1);

        await ctxA.close();
        await ctxB.close();
    });

    test('an expired disappearing message with an attachment shreds the file record and chunks too', async ({ browser }) => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const u = 'dsf_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        const fileId = await uploadFile(page, body.token, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(fileId).toBeTruthy();
        // Confirm the file exists before the message expires.
        const beforeOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); print(con.execute('SELECT COUNT(*) FROM files WHERE id=?', ('${fileId}',)).fetchone()[0])"`,
            { encoding: 'utf-8' }
        ).trim();
        expect(beforeOut).toBe('1');
        expect(existsSync(`server/uploads/${fileId}`)).toBe(true);

        expect(await sendChannelDisappearingViaWs(page, channelId, serverId, 'file will vanish', 5, fileId)).toBe('sent');
        await page.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        const messageId = await page.evaluate(() => {
            const el = document.querySelector('.message[data-expires-at]') as HTMLElement | null;
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(messageId).toBeTruthy();

        await page.waitForFunction((mid) => !document.querySelector(`.message[data-message-id="${mid}"]`), messageId, { timeout: 20000 });

        // The file record AND its on-disk chunks are gone (ciphertext shredded).
        // Poll: the 5s sweeper can lag the client-side DOM removal.
        let afterOut = '1';
        for (let i = 0; i < 20 && afterOut !== '0'; i++) {
            afterOut = execSync(
                `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); print(con.execute('SELECT COUNT(*) FROM files WHERE id=?', ('${fileId}',)).fetchone()[0])"`,
                { encoding: 'utf-8' }
            ).trim();
            if (afterOut !== '0') await new Promise((r) => setTimeout(r, 1000));
        }
        expect(afterOut).toBe('0');
        expect(existsSync(`server/uploads/${fileId}`)).toBe(false);

        await ctx.close();
    });

    test('composer: poll + disappearing picker live in the + popup and the armed badge shows', async ({ page }) => {
        const u = 'dsc_' + Date.now();
        const body = await registerUser(page, u);
        await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        // The standalone composer buttons are gone; both controls moved into the + popup.
        expect(await page.evaluate(() => !document.getElementById('poll-btn') && !document.querySelector('.disappear-wrap'))).toBe(true);
        // The emoji/sticker button must remain in the composer next to the + button.
        expect(await page.evaluate(() => !!document.getElementById('sticker-btn'))).toBe(true);
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible', timeout: 5000 });
        await page.click('#sticker-btn');

        await page.click('#attach-btn');
        await page.waitForSelector('#attach-popup', { state: 'visible', timeout: 5000 });
        expect(await page.evaluate(() => !!document.querySelector('.attach-popup-item[data-action="poll"]'))).toBe(true);

        // Open the disappearing submenu and arm 1 minute.
        await page.click('#disappear-btn');
        await page.waitForSelector('#disappear-menu', { state: 'visible', timeout: 5000 });
        await page.click('#disappear-menu .disappear-option[data-ttl="60"]');
        expect(await page.evaluate(() => document.getElementById('attach-btn')?.classList.contains('disappear-armed'))).toBe(true);

        // Sending through the UI carries the TTL: the message gets an expiry banner.
        await page.fill('#message-input', 'this one fades');
        await page.click('#send-btn');
        await page.waitForSelector('.message .disappearing-banner', { timeout: 8000 });
        const expiresAt = await page.evaluate(() => (document.querySelector('.message[data-expires-at]') as HTMLElement | null)?.getAttribute('data-expires-at') || '');
        expect(expiresAt).toBeTruthy();

        // Turn it back off: badge clears.
        await page.click('#attach-btn');
        await page.click('#disappear-btn');
        await page.click('#disappear-menu .disappear-option[data-ttl="0"]');
        expect(await page.evaluate(() => document.getElementById('attach-btn')?.classList.contains('disappear-armed'))).toBe(false);
    });

    test('out-of-bounds TTL (1s) is ignored: the message does not expire', async ({ page }) => {
        const u = 'dsb_' + Date.now();
        const body = await registerUser(page, u);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);
        await enterChannelView(page);

        // ttl=1 is below the 5s floor → the server stores no expiry.
        expect(await sendChannelDisappearingViaWs(page, channelId, serverId, 'stays forever', 1)).toBe('sent');
        await page.waitForSelector('.message', { timeout: 8000 });

        // No disappearing banner, and the message survives well past 5s.
        await page.waitForTimeout(7000);
        expect(await page.evaluate(() => document.querySelectorAll('.message .disappearing-banner').length)).toBe(0);
        const stillThere = await page.evaluate(() => {
            const el = document.querySelector('.message') as HTMLElement | null;
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(stillThere).toBeTruthy();
        const dbOut = execSync(
            `python3 -c "import sqlite3; con=sqlite3.connect('server/e2e_chat.db'); rows=con.execute('SELECT COUNT(*) FROM messages WHERE id=?', ('${stillThere}',)).fetchone(); print(rows[0])"`,
            { encoding: 'utf-8' }
        ).trim();
        expect(dbOut).toBe('1');
    });
});
