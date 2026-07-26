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

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
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

async function createBasicServer(page: any, token: string, userId: string, name: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name, invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await srv.json();

    // Upload server key for the owner
    await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });

    return { serverId: server.id, inviteCode };
}

test.describe('Rate Limiting', () => {

    test('join_server returns 429 after 10 rapid attempts', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        // Register an owner and create a server they can try to join
        const ownerUser = 'rl_owner_' + ts;
        const intruderUser = 'rl_intruder_' + ts;

        const owner = await registerUser(page, ownerUser);
        const { serverId, inviteCode } = await createBasicServer(page, owner.token, owner.user.id, 'RLTest_' + ts);

        // Register a second user (the intruder) in a new context
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        const intruder = await registerUser(page2, intruderUser);

        // Try to join server 11 times with INVALID codes — the 11th should be rate-limited
        // Using invalid codes ensures every attempt hits the rate limiter (not "already a member")
        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const badCode = 'FAKECODE_' + i;
            const res = await page2.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: `Bearer ${intruder.token}`, 'Content-Type': 'application/json' },
                data: { code: badCode },
            });
            lastStatus = res.status();
            lastBody = await res.json();
            console.log(`Join attempt ${i + 1}: status=${lastStatus}, body=${JSON.stringify(lastBody)}`);
        }

        // The 11th attempt should be 429 (rate limited)
        expect(lastStatus).toBe(429);
        expect(lastBody.error).toContain('Too many server join attempts');

        await ctx2.close();
    });

    test('join_server 10th attempt succeeds before rate limit kicks in', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ownerUser = 'rl_ok_' + ts;
        const joinerUser = 'rl_joiner_' + ts;

        // Create a valid server for joining
        const owner = await registerUser(page, ownerUser);
        // Use a unique invite code for each attempt so joins don't fail for \"already member\" reasons
        const inviteCodes: string[] = [];
        for (let i = 0; i < 10; i++) {
            inviteCodes.push(generateCode(8));
        }

        // Create server with the first invite code
        const server1 = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { name: 'RLTest2_' + ts, invite_code_hash: sha256Hex(inviteCodes[0]) },
        });
        const srv = await server1.json();

        await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: srv.id, userId: owner.user.id });

        // Set the server's invite hash to match, then regenerate multiple times
        // Actually, just try to join with invalid codes (rate limited by USER, not by code)
        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        const joiner = await registerUser(page2, joinerUser);

        // Use a bad invite code for the 11 attempts
        for (let i = 0; i < 11; i++) {
            const badCode = 'BADCODE' + (i < 10 ? '1' : 'X');
            const res = await page2.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: `Bearer ${joiner.token}`, 'Content-Type': 'application/json' },
                data: { code: badCode },
            });
            const status = res.status();
            const body = await res.json();
            console.log(`Attempt ${i + 1}: status=${status}, error=${body.error}`);

            if (i < 10) {
                // First 10 attempts should NOT be rate-limited (but may fail with invalid code)
                expect(status).not.toBe(429);
            } else {
                // 11th attempt should be rate limited
                expect(status).toBe(429);
                expect(body.error).toContain('Too many server join attempts');
            }
        }

        await ctx2.close();
    });

    test('send_friend_request returns 429 after 10 rapid attempts', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'rl_frA_' + ts;
        const userB = 'rl_frB_' + ts;

        const bodyA = await registerUser(page, userA);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bodyB = await registerUser(page2, userB);

        // Use an INVALID fake friend code for all attempts
        // Using a valid code would succeed on the first attempt and fail on subsequent
        // attempts with a different error (duplicate/friendship exists), never hitting the rate limiter.
        // Invalid codes ensure every attempt hits the rate limiter's check_and_increment.

        // Send 11 friend requests with fake codes — the 11th should be rate-limited
        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const fakeCode = 'ZZZZZZZZ' + i;
            const res = await page.request.post(`${BASE}/api/friends/request`, {
                headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
                data: { friend_code: fakeCode },
            });
            lastStatus = res.status();
            lastBody = await res.json();
            console.log(`Friend request attempt ${i + 1}: status=${lastStatus}, body=${JSON.stringify(lastBody)}`);
        }

        // The 11th attempt should be 429 (rate limited)
        expect(lastStatus).toBe(429);
        expect(lastBody.error).toContain('Too many friend request attempts');

        await page2.close();
        await ctx2.close();
    });

    test('send_friend_request 10th attempt succeeds before rate limit', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'rl_frOKA_' + ts;
        const userB = 'rl_frOKB_' + ts;

        const bodyA = await registerUser(page, userA);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bodyB = await registerUser(page2, userB);

        const friendCodeB = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));

        // Use a fake friend code to trigger rate limiter without actually creating requests
        const fakeCode = 'ZZZZZZZZ';

        for (let i = 0; i < 11; i++) {
            const res = await page.request.post(`${BASE}/api/friends/request`, {
                headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
                data: { friend_code: i < 10 ? fakeCode : 'XXXXXXXX' },
            });
            const status = res.status();
            const body = await res.json();
            console.log(`Attempt ${i + 1}: status=${status}, error=${body.error}`);

            if (i < 10) {
                // First 10 attempts should NOT be rate-limited (may fail with invalid code)
                expect(status).not.toBe(429);
            } else {
                // 11th attempt should be rate limited
                expect(status).toBe(429);
                expect(body.error).toContain('Too many friend request attempts');
            }
        }

        await page2.close();
        await ctx2.close();
    });
});
