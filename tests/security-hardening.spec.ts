import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
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

test.describe('Security Hardening', () => {

    // ─── P0: Sticker file_key NOT leaked in API responses ──────────

    test('sticker API does not return plaintext file_key', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const user = await registerUser(page, 'sk_no_key_' + ts);

        // Upload a file via the API
        const fileRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { size: 1024, mime: 'image/png' },
        });
        const fileData = await fileRes.json();
        expect(fileData.file_id).toBeDefined();

        // Upload a chunk — use evaluate with explicit URL to send raw bytes via fetch
        const baseUrl = BASE;
        const chunkResult = await page.evaluate(async ({ fileId, token, baseUrl }: { fileId: string; token: string; baseUrl: string }) => {
            const data = new Uint8Array(1024);
            const res = await fetch(`${baseUrl}/api/files/${fileId}/chunk/0`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
                body: data,
            });
            const text = await res.text();
            return { ok: res.ok, status: res.status, body: text };
        }, { fileId: fileData.file_id, token: user.token, baseUrl });
        console.log(`Chunk upload: status=${chunkResult.status}, body=${chunkResult.body}`);
        expect(chunkResult.ok).toBeTruthy();

        // Complete the upload
        const completeOk = await page.evaluate(async ({ fileId, token, baseUrl }: { fileId: string; token: string; baseUrl: string }) => {
            const res = await fetch(`${baseUrl}/api/files/${fileId}/complete`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.ok;
        }, { fileId: fileData.file_id, token: user.token, baseUrl });
        expect(completeOk).toBeTruthy();

        // Add a user sticker
        const stickerRes = await page.request.post(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: {
                file_id: fileData.file_id,
                sticker_name: 'test_sticker_' + ts,
                mime_type: 'image/png',
                file_key: null,
                encrypted_file_key: null,
                file_key_nonce: null,
            },
        });
        expect(stickerRes.ok()).toBeTruthy();

        // Fetch user stickers
        const listRes = await page.request.get(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${user.token}` },
        });
        expect(listRes.ok()).toBeTruthy();
        const stickers = await listRes.json();
        expect(Array.isArray(stickers)).toBeTruthy();

        for (const s of stickers) {
            expect(s).not.toHaveProperty('file_key');
            expect(s).toHaveProperty('encrypted_file_key');
            expect(s).toHaveProperty('file_key_nonce');
        }
    });

    // ─── P5: Registration password hash length check ───────────────

    test('registration rejects too-short password hash', async ({ page }) => {
        test.setTimeout(30000);
        const ts = Date.now();

        const res = await page.request.post(`${BASE}/api/register`, {
            headers: { 'Content-Type': 'application/json' },
            data: {
                username: 'rl_shortpw_' + ts,
                password: 'short',
            },
        });

        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('Password hash required');
    });

    // ─── P4: File size limit (50 MB) ───────────────────────────────

    test('file upload larger than 50 MB is rejected', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const user = await registerUser(page, 'rl_filesize_' + ts);

        const res = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { size: 60 * 1024 * 1024, mime: 'application/octet-stream' },
        });

        expect(res.status()).toBe(413);
        const body = await res.json();
        expect(body.error).toContain('max 50 MB');
    });

    test('file upload under 50 MB is accepted', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const user = await registerUser(page, 'rl_filesize_ok_' + ts);

        const res = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
            data: { size: 10 * 1024 * 1024, mime: 'application/octet-stream' },
        });

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.file_id).toBeDefined();
    });

    // ─── P2: HMAC key endpoint rate limiting ───────────────────────

    test('hmac-key endpoint returns 429 after 7 rapid requests', async ({ page }) => {
        test.setTimeout(60000);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 8; i++) {
            const res = await page.request.get(`${BASE}/api/hmac-key`);
            lastStatus = res.status();
            if (lastStatus === 429) {
                lastBody = await res.json();
                break;
            }
            if (i < 7) {
                expect(lastStatus).toBe(200);
            }
        }

        expect(lastStatus).toBe(429);
        expect(lastBody).not.toBeNull();
        expect(lastBody.error).toContain('Too many requests');
    });

    // ─── P1: Login IP rate limiting ─────────────────────────────────

    test('login returns 429 after 10 rapid attempts from same IP', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const username = 'rl_login_' + ts;

        await registerUser(page, username);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 12; i++) {
            const res = await page.request.post(`${BASE}/api/login`, {
                headers: { 'Content-Type': 'application/json' },
                data: { username, password: 'wrong_password_' + i },
            });
            lastStatus = res.status();
            lastBody = await res.json();
        }

        expect(lastStatus).toBe(429);
        expect(lastBody.error).toContain('Too many login attempts');
    });

    // ─── Regression: join_server rate limiting still works ─────────

    test('join_server returns 429 after 10 rapid attempts', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ownerUser = 'rl_srv_reg_' + ts;

        const owner = await registerUser(page, ownerUser);

        const inviteCode = 'INVITE_OK_' + ts;
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { name: 'RegTest_' + ts, invite_code_hash: sha256Hex(inviteCode) },
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
        }, { serverId: server.id, userId: owner.user.id });

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const intruder = await registerUser(page2, 'rl_int_reg_' + ts);

        let lastStatus = 0;
        let lastBody: any = null;
        for (let i = 0; i < 11; i++) {
            const badCode = 'INVALID_' + i;
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
});
