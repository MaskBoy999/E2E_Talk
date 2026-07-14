import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'http://localhost:3000';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

test.describe('Security', () => {

    // --- Admin Authentication ---

    test('admin endpoints reject requests without auth token', async ({ request }) => {
        const urls = [
            '/api/admin/users',
            '/api/admin/servers',
            '/api/admin/channels',
            '/api/admin/messages',
            '/api/admin/server-keys',
            '/api/admin/server-members',
        ];
        for (const url of urls) {
            const res = await request.get(`${BASE}${url}`);
            expect(res.status()).toBe(401);
        }
    });

    test('admin endpoints reject requests with invalid token', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/users`, {
            headers: { Authorization: 'Bearer invalid-token-12345' },
        });
        expect(res.status()).toBe(401);
    });

    test('admin login returns a token that grants access', async ({ request }) => {
        // Try to set the password with 'admin' (same as the admin panel test uses)
        const setup = await request.post(`${BASE}/api/admin/login`, {
            data: { password: 'admin' },
        });
        const setupData = await setup.json();
        const token = setupData.token;
        expect(token).toBeTruthy();

        // Now access admin endpoint with token
        const res = await request.get(`${BASE}/api/admin/users`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBeTruthy();
        const users = await res.json();
        expect(Array.isArray(users)).toBeTruthy();
    });

    // --- SQL Injection ---

    test('registration with SQL injection characters does not cause server error', async ({ request }) => {
        const sqliUsername = "'; DROP TABLE users; --_" + Date.now();
        const res = await request.post(`${BASE}/api/register`, {
            data: { username: sqliUsername, password: 'password123' },
        });
        // Should succeed (parameterized queries prevent SQL injection)
        // or fail with a validation error, but NOT cause a 500
        expect(res.status()).toBeLessThan(500);
    });

    test('SQL injection in login does not bypass authentication', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', "' OR '1'='1");
        await page.fill('#login-password', "' OR '1'='1");
        await page.click('#login-form button[type="submit"]');

        await page.waitForTimeout(2000);
        // Should NOT be on index.html (should still be on login)
        const url = page.url();
        expect(url).toContain('login');
    });

    // --- XSS Prevention ---

    test('username with HTML/script tags is escaped in server member list', async ({ page, context }) => {
        const ts = Date.now();
        const owner = 'xss_owner_' + ts;
        const xssUser = '<script>alert("xss")</script>' + ts;

        // Register owner
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', owner);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Register the XSS user in a separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForTimeout(500);
        await page2.click('#show-register');
        await page2.fill('#register-username', xssUser);
        await page2.fill('#register-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Owner creates a server and gets invite code
        const inviteCode = generateCode(8);
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'XSS Test Server', invite_code_hash: sha256Hex(inviteCode) },
        });
        const server = await srv.json();

        // Upload server key for owner
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body.user.id });

        // Set invite code hash
        await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { invite_code_hash: sha256Hex(inviteCode) },
        });

        // XSS user joins
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Owner uploads server key for XSS user
        const xssPubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, xssUserId, xssPubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(xssPubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: xssUserId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, xssUserId: body2.user.id, xssPubKey });

        // Load chat and check member list
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });

        // The XSS payload should not have been executed (no alert dialog)
        let alertFired = false;
        page.on('dialog', async dialog => {
            alertFired = true;
            await dialog.dismiss();
        });

        await page.waitForTimeout(2000);
        expect(alertFired).toBeFalsy();

        // Check the member list HTML doesn't contain raw script tags
        const memberListHtml = await page.evaluate(() => {
            const el = document.getElementById('member-list');
            return el ? el.innerHTML : '';
        });
        expect(memberListHtml).not.toContain('<script>');
        expect(memberListHtml).toContain('&lt;script&gt;');

        await page2.close();
        await ctx2.close();
    });

    // --- Input Validation ---

    test('empty username and password are rejected', async ({ request }) => {
        const res = await request.post(`${BASE}/api/register`, {
            data: { username: '', password: 'test123' },
        });
        expect(res.ok()).toBeFalsy();
    });

    test('empty password is rejected', async ({ request }) => {
        const res = await request.post(`${BASE}/api/register`, {
            data: { username: 'testuser_' + Date.now(), password: '' },
        });
        expect(res.ok()).toBeFalsy();
    });

    test('duplicate username registration is rejected', async ({ request }) => {
        const username = 'dup_test_' + Date.now();
        const res1 = await request.post(`${BASE}/api/register`, {
            data: { username, password: 'password123' },
        });
        expect(res1.ok()).toBeTruthy();

        const res2 = await request.post(`${BASE}/api/register`, {
            data: { username, password: 'password123' },
        });
        expect(res2.ok()).toBeFalsy();
    });

    // --- Authorization ---

    test('user cannot access other user DM conversations', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'authz_u1_' + ts;
        const user2 = 'authz_u2_' + ts;
        const user3 = 'authz_u3_' + ts;

        // Register all 3 users
        async function register(p: any, uname: string) {
            await p.goto(`${BASE}/login.html`);
            await p.waitForSelector('#show-register');
            await p.click('#show-register');
            await p.fill('#register-username', uname);
            await p.fill('#register-password', 'password123');
            await p.click('#register-form button[type="submit"]');
            await p.waitForURL('**/index.html', { timeout: 10000 });
            return await p.evaluate(() => ({
                token: localStorage.getItem('token'),
                user: JSON.parse(localStorage.getItem('user') || '{}'),
            }));
        }

        const b1 = await register(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const p2 = await ctx2.newPage();
        const b2 = await register(p2, user2);
        const ctx3 = await context.browser()!.newContext();
        const p3 = await ctx3.newPage();
        const b3 = await register(p3, user3);

        // user1 and user2 become friends (which auto-creates DM)
        const me2_code = await p2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${b1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: me2_code },
        });
        const incoming = await (await p2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${b2.token}` },
        })).json();
        await p2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });

        // Get DM conversations for user1
        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${b1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmId = convs[0].dm_channel_id;

        // user3 tries to access user1's DM - should fail
        const unauthorized = await p3.request.get(`${BASE}/api/dm/${dmId}/messages`, {
            headers: { Authorization: `Bearer ${b3.token}` },
        });
        expect(unauthorized.status()).toBeGreaterThanOrEqual(400);

        await p2.close();
        await ctx2.close();
        await p3.close();
        await ctx3.close();
    });

    // --- File Download Authorization ---

    test('unauthenticated file download is rejected', async ({ request }) => {
        const res = await request.get(`${BASE}/api/files/00000000-0000-0000-0000-000000000000/download`);
        expect(res.status()).toBe(401);
    });

    // --- CSP Headers ---

    test('responses include security headers', async ({ request }) => {
        const res = await request.get(`${BASE}/login.html`);
        const headers = res.headers();
        expect(headers['content-security-policy']).toBeTruthy();
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['x-frame-options']).toBe('DENY');
        expect(headers['referrer-policy']).toBe('no-referrer');
    });

    // --- Message Storage ---

    test('server never stores plaintext in messages', async ({ page }) => {
        const ts = Date.now();
        const username = 'sec_ct_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}` },
            data: { name: 'Sec CT Test', invite_code_hash: sha256Hex(generateCode(8)) },
        });
        const server = await srv.json();

        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateServerKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: body.user.id });

        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);

        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });
        await input.fill('This should be ciphertext on server');
        await page.click('#send-btn');
        await page.waitForTimeout(1500);

        // Verify via API that server only has ciphertext
        const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const msgs = await msgsRes.json();
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        for (const m of msgs) {
            expect(m).toHaveProperty('encrypted_content');
            expect(m).toHaveProperty('nonce');
            expect(m).not.toHaveProperty('content');
            // Encrypted content should be base64, not plaintext
            expect(m.encrypted_content).not.toContain('This should be ciphertext');
        }
    });
});
