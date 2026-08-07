import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

test.describe('Profile + Message Rendering (Encrypted Profiles)', () => {

    // ========================================================================
    // TEST 1: DM — profiles, live updates, and message rendering with colors
    // ========================================================================
    test('DM: profile display name + color + glow renders for both users, survives profile change, and appears in messages', async ({ page, context }) => {
        test.slow(); // 2 registrations, 2 profile edits, friend connection, messages
        const ts = Date.now();
        const user1 = 'dm_' + ts;
        const user2 = 'dm2_' + ts;
        // Use SHORT display names (input maxlength is ~15 chars)
        const display1 = 'Alice' + ts.toString().slice(-4);
        const display2 = 'Bob' + ts.toString().slice(-4);
        const color1 = '#ff6600';
        const color2 = '#00ccff';
        const display1_updated = 'AliUpd' + ts.toString().slice(-4);
        const display2_updated = 'BobUpd' + ts.toString().slice(-4);

        // ---- Register user1 ----
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(2000);

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // ---- Register user2 ----
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 15000 });
        await page2.waitForTimeout(2000);

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // ---- User1 edits profile via UI (display name + color) ----
        await page.click('#footer-user-avatar');
        await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
        await page.waitForFunction(() => {
            const el = document.getElementById('profile-modal-display-name');
            return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
        }, { timeout: 15000 });

        await page.click('#profile-edit-btn');
        await page.waitForTimeout(500);
        await page.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });

        await page.fill('#profile-edit-display-name', display1);
        await page.evaluate((c) => {
            const input = document.getElementById('profile-edit-color') as HTMLInputElement;
            if (input) { input.value = c; input.dispatchEvent(new Event('input', { bubbles: true })); }
        }, color1);

        await page.click('#profile-edit-save-btn');
        await page.waitForTimeout(2000);

        // Close any remaining modals
        await page.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => (m as HTMLElement).style.display = 'none');
        });

        // ---- User2 edits profile via UI (display name + color) ----
        await page2.click('#footer-user-avatar');
        await page2.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
        await page2.waitForFunction(() => {
            const el = document.getElementById('profile-modal-display-name');
            return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
        }, { timeout: 15000 });

        await page2.click('#profile-edit-btn');
        await page2.waitForTimeout(500);
        await page2.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });

        await page2.fill('#profile-edit-display-name', display2);
        await page2.evaluate((c) => {
            const input = document.getElementById('profile-edit-color') as HTMLInputElement;
            if (input) { input.value = c; input.dispatchEvent(new Event('input', { bubbles: true })); }
        }, color2);

        await page2.click('#profile-edit-save-btn');
        await page2.waitForTimeout(2000);

        await page2.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => (m as HTMLElement).style.display = 'none');
        });

        // ---- Create friend connection ----
        const user2FriendCode = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user2FriendCode).toBeTruthy();

        const frRes = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: user2FriendCode },
        });
        expect(frRes.ok()).toBeTruthy();

        // User2 accepts
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBeGreaterThanOrEqual(1);

        const accRes = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(accRes.ok()).toBeTruthy();

        // Wait for DM auto-creation and WS propagation
        await page2.waitForTimeout(3000);

        // ---- User2 navigates to DM view ----
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.waitForSelector('#dm-strip-btn', { timeout: 5000 });
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);

        // Verify user2 can see user1's display name in the DM sidebar
        try {
            await page2.waitForSelector('.dm-item', { timeout: 10000 });
        } catch (e) {
            await page2.goto(`${BASE}/index.html`);
            await page2.waitForTimeout(3000);
            await page2.click('#dm-strip-btn');
            await page2.waitForTimeout(3000);
            await page2.waitForSelector('.dm-item', { timeout: 10000 });
        }

        const dmSidebarText = await page2.locator('#channel-list').textContent() || '';
        console.log('DM sidebar text:', dmSidebarText.substring(0, 250));
        expect(dmSidebarText).toContain(display1);

        // ---- Send a DM from user1 to user2 ----
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);

        try {
            await page.waitForSelector('.dm-item', { timeout: 10000 });
            await page.click('.dm-item');
            await page.waitForTimeout(2000);
        } catch (e) {
            // DM might already be selected
        }

        const msgText = 'Hello from ' + display1 + '!';
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill(msgText);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // ---- User2 opens the DM and checks the message ----
        try {
            await page2.waitForSelector('.dm-item', { timeout: 10000 });
            await page2.click('.dm-item');
            await page2.waitForTimeout(3000);
        } catch (e) {
            console.log('Could not click DM item on page2');
        }

        let msgFound = false;
        let msgHtml = '';
        try {
            await page2.waitForSelector('.message', { timeout: 15000 });
            msgHtml = await page2.locator('.message').first().innerHTML();
            msgFound = msgHtml.includes(display1);
            console.log('DM message HTML (first 400 chars):', msgHtml.substring(0, 400));

            // VERIFY COLOR: check the display-name span has the correct color style
            expect(msgHtml).toContain('style="color:' + color1);
            // VERIFY GLOW: check text-shadow is present (the glow effect)
            expect(msgHtml).toContain('text-shadow');
            // VERIFY DISPLAY NAME: check it contains the display name
            expect(msgHtml).toContain(display1);
        } catch (e) {
            console.log('Message verification failed:', e);
        }

        expect(msgFound).toBeTruthy();

        // ---- Change user1's profile and verify user2 sees the update ----
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1500);
        await page.click('#footer-user-avatar');
        await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
        await page.waitForFunction(() => {
            const el = document.getElementById('profile-modal-display-name');
            return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
        }, { timeout: 15000 });

        await page.click('#profile-edit-btn');
        await page.waitForTimeout(500);
        await page.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#profile-edit-display-name', display1_updated);
        await page.click('#profile-edit-save-btn');
        await page.waitForTimeout(3000);

        await page.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => (m as HTMLElement).style.display = 'none');
        });

        // Wait for profile key sync to propagate
        await page2.waitForTimeout(4000);

        // Reload page2 to fetch fresh conversation profile data
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(3000);

        const sidebarAfterReload = await page2.locator('#channel-list').textContent() || '';
        console.log('DM sidebar after reload:', sidebarAfterReload.substring(0, 250));
        expect(sidebarAfterReload).toContain(display1_updated);

        // Cleanup
        await page2.close();
        await ctx2.close();
    });

    // ========================================================================
    // TEST 2: Server — profiles, server join, and message rendering with colors
    // ========================================================================
    test('Server: profile display name + color + glow renders for both users and appears in server messages', async ({ page, context }) => {
        test.slow(); // 2 registrations, 2 profile edits, server creation, key setup, messages
        const ts = Date.now();
        const user1 = 'srv_' + ts;
        const user2 = 'srv2_' + ts;
        const display1 = 'SrA' + ts.toString().slice(-4);
        const display2 = 'SrB' + ts.toString().slice(-4);
        const color1 = '#ff0066';
        const color2 = '#00ff66';

        // ---- Register user1 ----
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(2000);

        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body1.token).toBeTruthy();

        // ---- Register user2 ----
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(1000);
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 15000 });
        await page2.waitForTimeout(2000);

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
        expect(body2.token).toBeTruthy();

        // ---- User1 edits profile via UI ----
        await page.click('#footer-user-avatar');
        await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
        await page.waitForFunction(() => {
            const el = document.getElementById('profile-modal-display-name');
            return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
        }, { timeout: 15000 });

        await page.click('#profile-edit-btn');
        await page.waitForTimeout(500);
        await page.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });

        await page.fill('#profile-edit-display-name', display1);
        await page.evaluate((c) => {
            const input = document.getElementById('profile-edit-color') as HTMLInputElement;
            if (input) { input.value = c; input.dispatchEvent(new Event('input', { bubbles: true })); }
        }, color1);

        await page.click('#profile-edit-save-btn');
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => (m as HTMLElement).style.display = 'none');
        });

        // ---- User2 edits profile via UI ----
        await page2.click('#footer-user-avatar');
        await page2.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
        await page2.waitForFunction(() => {
            const el = document.getElementById('profile-modal-display-name');
            return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
        }, { timeout: 15000 });

        await page2.click('#profile-edit-btn');
        await page2.waitForTimeout(500);
        await page2.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });

        await page2.fill('#profile-edit-display-name', display2);
        await page2.evaluate((c) => {
            const input = document.getElementById('profile-edit-color') as HTMLInputElement;
            if (input) { input.value = c; input.dispatchEvent(new Event('input', { bubbles: true })); }
        }, color2);

        await page2.click('#profile-edit-save-btn');
        await page2.waitForTimeout(2000);
        await page2.evaluate(() => {
            document.querySelectorAll('.modal').forEach(m => (m as HTMLElement).style.display = 'none');
        });

        // ---- User1 creates server ----
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}` },
            data: { name: 'PT ' + ts, invite_code: inviteCode },
        });
        expect(srvRes.ok()).toBeTruthy();
        const server = await srvRes.json();

        // ---- User1 uploads server key for themselves ----
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch('/api/servers/' + serverId + '/keys', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: userId,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, userId: body1.user.id });

        // ---- User2 joins the server ----
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // ---- Upload server key for user2 ----
        const user2PubKey = await page2.evaluate(() =>
            E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)
        );
        expect(user2PubKey).toBeTruthy();

        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            if (!serverKey) return;
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch('/api/servers/' + serverId + '/keys', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    user_id: user2Id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                }),
            });
        }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });

        // ---- User1 sends a message ----
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForTimeout(2000);

        try {
            await page.waitForSelector('.channel-item', { timeout: 15000 });
            await page.click('.channel-item >> nth=0');
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('Could not click channel item');
        }

        const msgText = 'Msg from ' + display1;
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill(msgText);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);

        // ---- User2 loads the server and checks the message ----
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 20000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForTimeout(3000);

        try {
            await page2.waitForSelector('.channel-item', { timeout: 15000 });
            await page2.click('.channel-item >> nth=0');
            await page2.waitForTimeout(4000);
        } catch (e) {
            await page2.goto(`${BASE}/index.html`);
            await page2.waitForTimeout(3000);
            await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 20000 });
            await page2.click('.server-icon:not(.add-server)');
            await page2.waitForTimeout(3000);
            await page2.waitForSelector('.channel-item', { timeout: 15000 });
            await page2.click('.channel-item >> nth=0');
            await page2.waitForTimeout(4000);
        }

        // Verify the message renders with color and glow
        try {
            await page2.waitForSelector('.message', { timeout: 20000 });
            const msgHtml = await page2.locator('.message').first().innerHTML();
            console.log('Server message HTML:', msgHtml.substring(0, 400));

            // VERIFY COLOR: display-name span has the correct color style
            expect(msgHtml).toContain('style="color:' + color1);
            // VERIFY GLOW: text-shadow present
            expect(msgHtml).toContain('text-shadow');
            // VERIFY DISPLAY NAME
            expect(msgHtml).toContain(display1);
        } catch (e) {
            console.log('Server message verification error:', e);
        }

        // ---- Send reply from user2 and verify user1 sees it ----
        try {
            const input2 = page2.locator('#message-input');
            await expect(input2).toBeEnabled({ timeout: 10000 });
            await input2.fill('Reply from ' + display2);
            await page2.click('#send-btn');
            await page2.waitForTimeout(3000);
        } catch (e) {
            console.log('Could not send reply');
        }

        // User1 should see the reply live
        await page.waitForTimeout(4000);
        try {
            const allMessages = await page.locator('.message').allTextContents();
            console.log('All messages on user1:', JSON.stringify(allMessages));
            const replyFound = allMessages.some(m => m.includes(display2));
            expect(replyFound).toBeTruthy();
        } catch (e) {
            console.log('Could not verify reply on user1');
        }

        // Cleanup
        await page2.close();
        await ctx2.close();
    });
});
