import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// --- Pure-JS TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s) for test assertions ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Uint8Array {
    const out: number[] = [];
    let buffer = 0, bits = 0;
    for (const c of s.trim().toUpperCase()) {
        const v = B32.indexOf(c);
        if (v < 0) continue;
        buffer = (buffer << 5) | v;
        bits += 5;
        if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
    }
    return new Uint8Array(out);
}

function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
    // SHA-1 in pure JS (FIPS 180-4)
    function sha1(m: Uint8Array): Uint8Array {
        const ml = m.length;
        const msgWithPad = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
        msgWithPad.set(m);
        msgWithPad[ml] = 0x80;
        const dv = new DataView(msgWithPad.buffer);
        dv.setUint32(msgWithPad.length - 4, ml * 8, false);
        let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
        const w = new Uint32Array(80);
        for (let i = 0; i < msgWithPad.length; i += 64) {
            for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
            for (let j = 16; j < 80; j++) {
                const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
                w[j] = (n << 1) | (n >>> 31);
            }
            let a = h0, b = h1, c = h2, d = h3, e = h4;
            for (let j = 0; j < 80; j++) {
                let f: number, k: number;
                if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
                else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
                else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
                else { f = b ^ c ^ d; k = 0xCA62C1D6; }
                const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
                e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
        }
        const out = new Uint8Array(20);
        const ov = new DataView(out.buffer);
        ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
        ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
        return out;
    }
    const block = new Uint8Array(64).fill(0);
    if (key.length > 64) block.set(sha1(key).slice(0, 64)); else block.set(key);
    const ipad = block.map((b) => b ^ 0x36);
    const opad = block.map((b) => b ^ 0x5c);
    const inner = new Uint8Array(ipad.length + msg.length);
    inner.set(ipad); inner.set(msg, ipad.length);
    const innerHash = sha1(inner);
    const outer = new Uint8Array(opad.length + innerHash.length);
    outer.set(opad); outer.set(innerHash, opad.length);
    return sha1(outer);
}

function totpCode(secretB32: string, atSecs?: number): string {
    const time = atSecs ?? Math.floor(Date.now() / 1000);
    const counter = Math.floor(time / 30);
    const msg = new Uint8Array(8);
    const dv = new DataView(msg.buffer);
    dv.setUint32(4, counter >>> 0, false);
    dv.setUint32(0, Math.floor(counter / 0x100000000), false);
    const mac = hmacSha1(base32Decode(secretB32), msg);
    const offset = mac[19] & 0x0f;
    const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

// Register a fresh user via the UI (identity keys + token) and return helpers.
async function registerUser(page: any, uname: string, password = 'password123') {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', uname);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { timeout: 10000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}'));
    expect(token).toBeTruthy();
    return { token: token as string, user };
}

// Compute the client-side login hash (same as auth.js) inside the page context.
async function loginHash(page: any, username: string, password: string): Promise<string> {
    return page.evaluate(async ({ username, password }) => {
        const res = await fetch('/api/auth-params/' + encodeURIComponent(username));
        const params = await res.json();
        if (params.encrypted_hash_key && params.hash_key_salt && params.hash_key_nonce) {
            const hashKeyB64 = E2ECrypto.decryptWithPassword(
                params.encrypted_hash_key, password, params.hash_key_salt, params.hash_key_nonce
            );
            if (hashKeyB64) {
                const bytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(hashKeyB64));
                return E2ECrypto.hmacHex(bytes, password);
            }
        }
        return password; // legacy fallback
    }, { username, password });
}

async function enroll(page: any, token: string, hash: string) {
    const res = await page.request.post(`${BASE}/api/2fa/enroll`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { password: hash },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.secret_base32).toBeTruthy();
    expect(data.otpauth_url).toContain('otpauth://totp/');
    expect(data.recovery_codes).toHaveLength(8);
    return data;
}

test.describe('Two-factor authentication (TOTP)', () => {
    test('enroll: wrong password rejected, bad code rejected, valid code enables; status flips', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_enroll_' + ts;
        const { token, user } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');

        // Wrong password on enroll → 401.
        const wrongPw = await page.request.post(`${BASE}/api/2fa/enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { password: 'x'.repeat(64) },
        });
        expect(wrongPw.status()).toBe(401);

        // Valid enroll.
        const data = await enroll(page, token, hash);
        expect(data.otpauth_url).toContain(encodeURIComponent(uname) || uname);

        // Verify with a WRONG code → 401, still disabled.
        const badVerify = await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: '000000' },
        });
        expect(badVerify.status()).toBe(401);
        let status = await (await page.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
        expect(status.enabled).toBe(false);

        // Verify with the real TOTP code → enabled.
        const goodVerify = await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });
        expect(goodVerify.status()).toBe(200);
        status = await (await page.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
        expect(status.enabled).toBe(true);
        expect(user.id).toBeTruthy();
    });

    test('login: password alone returns two_factor_required + pending token; correct code logs in', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_correct_' + ts;
        const { token } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');
        const data = await enroll(page, token, hash);
        await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });

        // Password step → pending token, no session.
        const loginRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, duration_seconds: 3600 },
        });
        expect(loginRes.status()).toBe(200);
        const loginData = await loginRes.json();
        expect(loginData.two_factor_required).toBe(true);
        expect(loginData.pending_token).toBeTruthy();
        expect(loginData.token).toBeFalsy();

        // Code step → real session.
        const codeRes = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: loginData.pending_token, code: totpCode(data.secret_base32) },
        });
        expect(codeRes.status()).toBe(200);
        const codeData = await codeRes.json();
        expect(codeData.token).toBeTruthy();
        expect(codeData.user.username).toBe(uname);
    });

    test('login: wrong code is rejected with 401', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_wrong_' + ts;
        const { token } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');
        const data = await enroll(page, token, hash);
        await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });

        const loginRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, duration_seconds: 3600 },
        });
        const loginData = await loginRes.json();

        const bad = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: loginData.pending_token, code: '123456' },
        });
        expect(bad.status()).toBe(401);

        // The pending token stays usable for the real code (wrong code ≠ consumed).
        const good = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: loginData.pending_token, code: totpCode(data.secret_base32) },
        });
        expect(good.status()).toBe(200);
    });

    test('recovery codes: one-time use — first works, second is rejected', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_recovery_' + ts;
        const { token } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');
        const data = await enroll(page, token, hash);
        await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });
        const recoveryCode = data.recovery_codes[0];

        // Login with the recovery code.
        const loginRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, duration_seconds: 3600 },
        });
        const loginData = await loginRes.json();
        const first = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: loginData.pending_token, code: recoveryCode },
        });
        expect(first.status()).toBe(200);

        // Reuse the SAME code → rejected (one-time).
        const loginRes2 = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, duration_seconds: 3600 },
        });
        const loginData2 = await loginRes2.json();
        const second = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: loginData2.pending_token, code: recoveryCode },
        });
        expect(second.status()).toBe(401);
    });

    test('admin: user shows 2FA ON, force-disable removes it, plain login works again', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_admin_' + ts;
        const { token, user } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');
        const data = await enroll(page, token, hash);
        await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });

        // Admin login (dev DB admin password is 'admin' from prior setup).
        let adminToken = '';
        for (const pw of ['admin', 'auditadmin', 'admin123']) {
            const res = await page.request.post(`${BASE}/api/admin/login`, { data: { password: pw } });
            if (res.ok()) { adminToken = (await res.json()).token || ''; break; }
        }
        expect(adminToken, 'admin logged in').toBeTruthy();

        // Users list shows 2FA ON for this user.
        const users = await (await page.request.get(`${BASE}/api/admin/users`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        })).json();
        const row = (users as any[]).find((u) => u.id === user.id);
        expect(row).toBeTruthy();
        expect(row.two_factor_enabled).toBe(true);

        // Force-disable via admin.
        const disable = await page.request.post(`${BASE}/api/admin/users/${user.id}/disable-2fa`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(disable.status()).toBe(200);

        // Users list now shows Off.
        const users2 = await (await page.request.get(`${BASE}/api/admin/users`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        })).json();
        expect((users2 as any[]).find((u) => u.id === user.id).two_factor_enabled).toBe(false);

        // Plain login works again (no 2FA step).
        const loginRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, duration_seconds: 3600 },
        });
        const loginData = await loginRes.json();
        expect(loginData.two_factor_required).toBeFalsy();
        expect(loginData.token).toBeTruthy();
    });

    test('default OFF for a fresh account; settings-UI enrollment flips it ON', async ({ page }) => {
        const ts = Date.now();
        const uname = 'tfa_ui_' + ts;
        const { token } = await registerUser(page, uname);

        // 2FA is OFF by default — no enrollment needed.
        let status = await (await page.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
        expect(status.enabled).toBe(false);

        // Open Settings → Security tab.
        await page.click('#settings-btn');
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.waitForSelector('#twofa-status-line');
        const offLine = await page.textContent('#twofa-status-line');
        expect(offLine).toContain('OFF');

        // Enable 2FA through the modal UI (password → QR step).
        await page.click('#enable-2fa-btn');
        await page.waitForSelector('#twofa-enroll-modal', { state: 'visible' });
        await page.fill('#twofa-password', 'password123');
        await page.click('#twofa-start-btn');
        await page.waitForSelector('#twofa-step-qr', { state: 'visible' });

        // Read the secret shown on screen (QR may or may not render without CDN;
        // the manual secret is always there). Recovery codes are shown too.
        const secretText = (await page.textContent('#twofa-secret-text')) || '';
        const secret = secretText.replace('Secret:', '').trim();
        expect(secret.length).toBeGreaterThan(10);
        const codes = await page.$$eval('#twofa-recovery-codes span', (els) => els.map((e) => e.textContent));
        expect(codes).toHaveLength(8);

        // Verify with the real TOTP code → enabled, modal closes, status flips.
        await page.fill('#twofa-verify-code', totpCode(secret));
        await page.click('#twofa-verify-btn');
        await page.waitForSelector('#twofa-enroll-modal', { state: 'hidden' });
        await page.waitForFunction(() => {
            const el = document.getElementById('twofa-status-line');
            return el && el.textContent && el.textContent.includes('ON');
        }, undefined, { timeout: 10000 });

        status = await (await page.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
        expect(status.enabled).toBe(true);
    });

    test('multi-device: enrolling does NOT kick existing sessions; a second device logs in with the code and both sessions coexist', async ({ browser }) => {
        const ts = Date.now();
        const uname = 'tfa_multi_' + ts;
        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        const { token } = await registerUser(pageA, uname);
        const hash = await loginHash(pageA, uname, 'password123');
        const data = await enroll(pageA, token, hash);
        await pageA.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: totpCode(data.secret_base32) },
        });

        // Device A's existing session survives enrollment.
        const stillAuth = await pageA.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } });
        expect(stillAuth.status()).toBe(200);
        expect((await stillAuth.json()).enabled).toBe(true);

        // Device B (fresh context = separate device) logs in → 2FA step → code.
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForTimeout(400);
        await pageB.fill('#login-username', uname);
        await pageB.fill('#login-password', 'password123');
        await pageB.click('#login-form button[type="submit"]');
        await pageB.waitForSelector('#login-2fa-form', { state: 'visible', timeout: 10000 });
        await pageB.fill('#login-2fa-code', totpCode(data.secret_base32));
        await pageB.click('#login-2fa-form button[type="submit"]');
        await pageB.waitForURL('**/index.html', { timeout: 15000 });
        const tokenB = await pageB.evaluate(() => localStorage.getItem('token'));
        expect(tokenB).toBeTruthy();

        // Both sessions are valid and BOTH are listed in the device panel API.
        const aStill = await pageA.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${token}` } });
        expect(aStill.status()).toBe(200);
        const bOk = await pageB.request.get(`${BASE}/api/2fa/status`, { headers: { Authorization: `Bearer ${tokenB}` } });
        expect(bOk.status()).toBe(200);
        const sessions = await (await pageB.request.get(`${BASE}/api/auth/sessions`, {
            headers: { Authorization: `Bearer ${tokenB}` },
        })).json();
        const sessionList = Array.isArray(sessions) ? sessions : (sessions.sessions as any[]);
        expect(Array.isArray(sessionList)).toBe(true);
        expect(sessionList.length).toBeGreaterThanOrEqual(2);
        // Both devices are actually listed (not just duplicates of one).
        expect(sessionList.filter((s: any) => !s.revoked).length).toBeGreaterThanOrEqual(2);

        await ctxA.close();
        await ctxB.close();
    });
});
