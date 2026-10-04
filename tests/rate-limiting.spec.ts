import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

// Rate limits are raised or disabled for the main server by
// playwright.config.ts (dozens of users register from one IP), so the budget
// tests run against an isolated server whose limiters keep their production
// defaults. Every test here shares one temp DB + one process.
const ALT = 'https://localhost:3463';

let child: ChildProcess | null = null;
let tmpDb = '';

function httpsProbe(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const req = https.get(url, { rejectUnauthorized: false }, (res) => {
            res.resume();
            resolve(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
}

function httpsPostJson(url: string, body: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = https.request(url, {
            method: 'POST',
            rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: out }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.write(data);
        req.end();
    });
}

async function registerUser(page: any, username: string) {
    await page.goto(`${ALT}/login.html`);
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
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let inviteCode = '';
    for (let i = 0; i < 8; i++) inviteCode += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const srv = await page.request.post(`${ALT}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name, invite_code: inviteCode },
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

function randomHex64(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 64; i++) result += chars[Math.floor(Math.random() * 16)];
    return result;
}

test.describe('Rate Limiting & Friend-Code Validation — isolated server + temp DB', () => {
    test.beforeAll(async () => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `ratelimit-test-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: '3462',
                HTTPS_PORT: '3463',
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                // Registration / login plumbing is noise here — raise it so the
                // suite's own users never trip those budgets. The friend-request
                // and join budgets keep their defaults: those are under test.
                REGISTER_IP_MAX: '100000',
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
                CLIENT_CONFIG_IP_MAX: '100000',
                MUTATION_USER_MAX: '100000',
                MUTATION_IP_MAX: '100000',
                FRIEND_REQUEST_IP_MAX: '10',
                FRIEND_REQUEST_USER_MAX: '10',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            if (await httpsProbe(ALT + '/')) { up = true; break; }
            await new Promise((r) => setTimeout(r, 300));
        }
        expect(up, 'isolated server came up').toBe(true);

        // A fresh DB redirects every non-admin path to /admin.html until the
        // admin password is set (static_not_found guard in main.rs), so first
        // visits to /login.html never render. The first admin login performs
        // the setup and returns a token; that clears the redirect.
        const setup = await httpsPostJson(`${ALT}/api/admin/login`, { password: 'ratelimit' });
        expect(setup.status, 'admin setup clears the fresh-DB redirect').toBe(200);
        expect(JSON.parse(setup.body).token).toBeTruthy();
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
            try { fs.unlinkSync(tmpDb + '-wal'); } catch (_) {}
            try { fs.unlinkSync(tmpDb + '-shm'); } catch (_) {}
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
        }
    });

    // ─── Friend-code validation (current protocol: raw code, server hashes) ─

    test('friend request with a malformed or unknown friend code returns 400, never 500', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const user = await registerUser(page, 'rl_fr_hash_' + ts);

        const cases = [
            'too_short',
            'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
            randomHex64(), // valid shape, no such user
        ];
        for (const friendCode of cases) {
            const res = await page.request.post(`${ALT}/api/friends/request`, {
                headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
                data: { friend_code: friendCode },
            });
            expect(res.status(), `status for ${friendCode.slice(0, 12)}…`).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('No user with that friend code');
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
        expect(serverId).toBeTruthy();
        expect(inviteCode).toBeTruthy();

        const ctx2 = await page.context().browser()!.newContext();
        const page2 = await ctx2.newPage();
        const intruder = await registerUser(page2, intruderUser);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const badCode = 'FAKECODE_' + i;
            const res = await page2.request.post(`${ALT}/api/invites/join`, {
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
        await registerUser(page2, userB);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const fakeCode = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + String(i % 10) + String(Math.floor(i / 10));
            const res = await page.request.post(`${ALT}/api/friends/request`, {
                headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
                data: { friend_code: fakeCode },
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
