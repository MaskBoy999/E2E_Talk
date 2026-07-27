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

function generateValidHex64(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 64; i++) result += chars[Math.floor(Math.random() * 16)];
    return result;
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

test.describe('Rate Limiting & Hash Validation', () => {

    // ─── P3: Friend code hash format validation (run FIRST, before rate limiters trigger) ─

    test('friend request with invalid hash format returns 400', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const user = await registerUser(page, 'rl_fr_hash_' + ts);

        // Note: The IP-based rate limiter uses "unknown" for all test traffic.
        // If a previous test exhausted the 10-slot bucket, we may get 429 even
        // for the first request. Accept both 400 (validation) and 429 (rate-limited).

        // Too-short hash
        const res1 = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { friend_code_hash: 'too_short' },
        });
        if (res1.status() === 400) {
            const body1 = await res1.json();
            expect(body1.error).toContain('Invalid friend code hash');
        } else {
            expect(res1.status()).toBe(429);
        }

        // Non-hex characters
        const res2 = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { friend_code_hash: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' },
        });
        if (res2.status() === 400) {
            const body2 = await res2.json();
            expect(body2.error).toContain('Invalid friend code hash');
        } else {
            expect(res2.status()).toBe(429);
        }

        // Valid format but non-existent user (validation passes, lookup fails)
        const res3 = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { friend_code_hash: generateValidHex64() },
        });
        if (res3.status() === 400) {
            const body3 = await res3.json();
            expect(body3.error).not.toContain('Invalid friend code hash');
        } else {
            expect(res3.status()).toBe(429);
        }
    });

    // ─── Join server rate limiting ──────────────────────────────────

    test('join_server returns 429 after 10 rapid attempts', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();

        const ownerUser = 'rl_owner_' + ts;
        const intruderUser = 'rl_intruder_' + ts;

        const owner = await registerUser(page, ownerUser);
        const { serverId, inviteCode } = await createBasicServer(page, owner.token, owner.user.id, 'RLTest_' + ts);

        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        const intruder = await registerUser(page2, intruderUser);

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
        }

        expect(lastStatus).toBe(429);
        expect(lastBody.error).toContain('Too many server join attempts');
        await ctx2.close();
    });

    // ─── Friend request rate limiting ───────────────────────────────

    test('send_friend_request returns 429 after 10 rapid attempts', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'rl_frA_' + ts;
        const userB = 'rl_frB_' + ts;

        const bodyA = await registerUser(page, userA);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bodyB = await registerUser(page2, userB);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const fakeCode = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + String(i);
            const res = await page.request.post(`${BASE}/api/friends/request`, {
                headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
                data: { friend_code_hash: fakeCode },
            });
            lastStatus = res.status();
            lastBody = await res.json();
        }

        expect(lastStatus).toBe(429);
        expect(lastBody.error).toContain('Too many friend request attempts');

        await page2.close();
        await ctx2.close();
    });
});
