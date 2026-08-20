import { test, expect, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const BASE = 'https://localhost:3443';
const DB = 'server/e2e_chat.db';

// ---------- DB helpers ----------
function dbQuery(sql: string, args: any[] = []): any[] {
    const json = JSON.stringify(args).replace(/'/g, "''");
    const script = `import sqlite3,sys,json;con=sqlite3.connect(${JSON.stringify(DB)});cur=con.cursor();cur.execute(${JSON.stringify(sql)},json.loads('${json}'));print(json.dumps(cur.fetchall()))`;
    const out = execSync(`python3 -c ${JSON.stringify(script)}`, { encoding: 'utf8' }).trim();
    return JSON.parse(out);
}
function dbExec(sql: string, args: any[] = []): void {
    const json = JSON.stringify(args).replace(/'/g, "''");
    const script = `import sqlite3,json;con=sqlite3.connect(${JSON.stringify(DB)});cur=con.cursor();cur.execute(${JSON.stringify(sql)},json.loads('${json}'));con.commit()`;
    execSync(`python3 -c ${JSON.stringify(script)}`, { encoding: 'utf8' });
}

// ---------- TOTP helpers (RFC 6238, SHA-1, 6 digits, SubtleCrypto) ----------
function base32Decode(s: string): Uint8Array {
    const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of s.replace(/=+$/, '').toUpperCase()) bits += ALPH.indexOf(c).toString(2).padStart(5, '0');
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return bytes;
}
async function hmacSha1(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
}
async function totpCode(secretB32: string, atSecs?: number): Promise<string> {
    const time = atSecs ?? Math.floor(Date.now() / 1000);
    const counter = Math.floor(time / 30);
    const msg = new Uint8Array(8);
    const dv = new DataView(msg.buffer);
    dv.setUint32(4, counter >>> 0, false);
    dv.setUint32(0, Math.floor(counter / 0x100000000), false);
    const mac = await hmacSha1(base32Decode(secretB32), msg);
    const offset = mac[19] & 0x0f;
    const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

// ---------- App helpers ----------
async function registerUser(page: Page, uname: string, password = 'password123') {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(300);
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

async function loginHash(page: Page, username: string, password: string): Promise<string> {
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
        return password;
    }, { username, password });
}

// Decrypt the kill-switch verifier exactly like auth.js does at login.
async function killSwitchProof(page: Page, username: string, ksPassword: string): Promise<string> {
    return page.evaluate(async ({ username, ksPassword }) => {
        const res = await fetch('/api/auth-params/' + encodeURIComponent(username));
        const params = await res.json();
        return E2ECrypto.decryptWithPassword(
            params.kill_switch_verifier_encrypted, ksPassword,
            params.kill_switch_wrap_salt, params.kill_switch_wrap_nonce
        );
    }, { username, ksPassword });
}

// Build the exact kill-switch blob the settings UI builds, and POST it.
async function armKillSwitchApi(page: Page, token: string, realPassword: string, ksPassword: string): Promise<boolean> {
    const res = await page.evaluate(async ({ token, realPassword, ksPassword }) => {
        const authKeyB64 = localStorage.getItem('e2e_auth_key');
        if (!authKeyB64) return { ok: false, error: 'no e2e_auth_key' };
        const key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(authKeyB64));
        const current_password = E2ECrypto.hmacHex(key, realPassword);
        const saltBytes = new Uint8Array(16);
        crypto.getRandomValues(saltBytes);
        let ksSalt = '';
        for (let i = 0; i < 16; i++) ksSalt += (saltBytes[i] < 16 ? '0' : '') + saltBytes[i].toString(16);
        const verifier = E2ECrypto.hmacHex(ksSalt, ksPassword);
        const check = E2ECrypto.hmacHex(verifier, 'kill-switch-check');
        const wrapped = E2ECrypto.encryptWithPassword(verifier, ksPassword);
        const res = await fetch('/api/me/kill-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                current_password,
                verifier_encrypted: wrapped.encrypted_private_key,
                wrap_salt: wrapped.salt,
                wrap_nonce: wrapped.nonce,
                ks_salt: ksSalt,
                check,
            }),
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, error: data.error };
    }, { token, realPassword, ksPassword });
    return res.ok;
}

// ---------- Tests ----------
test.describe('Kill Switch', () => {
    test('server cannot forge a kill-switch login from stored data; wrong proof is just a failed login', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_forge_' + ts;
        const { token, user } = await registerUser(page, uname);
        expect(await armKillSwitchApi(page, token, 'password123', 'killpass99')).toBe(true);

        // The DB must hold only the wrapped verifier + check HMAC — never the
        // raw kill-switch password or the plaintext verifier.
        const rows = dbQuery(
            "SELECT kill_switch_verifier_encrypted, kill_switch_wrap_salt, kill_switch_wrap_nonce, kill_switch_salt, kill_switch_check FROM users WHERE id = ?1",
            [user.id]
        );
        expect(rows).toHaveLength(1);
        const [ksVer, ksWrapSalt, ksWrapNonce, ksSalt, ksCheck] = rows[0] as string[];
        expect(ksCheck).toMatch(/^[0-9a-f]{64}$/);
        expect(ksSalt).toMatch(/^[0-9a-f]{32}$/);
        expect(ksVer).not.toContain('killpass99');
        expect(ksCheck).not.toContain('killpass99');
        expect(ksVer.length).toBeGreaterThan(20);

        // Even a proof crafted from the stored check value itself must fail:
        // the login proof is the VERIFIER (preimage of the check), which the
        // server cannot derive from stored data.
        const forged = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: '', kill_switch_proof: ksCheck },
        });
        expect(forged.status()).toBe(401);

        // A completely random proof also fails.
        const randomProof = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: '', kill_switch_proof: 'a'.repeat(64) },
        });
        expect(randomProof.status()).toBe(401);

        // Account still exists and the real password still works.
        const realHash = await loginHash(page, uname, 'password123');
        const ok = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: realHash },
        });
        expect(ok.status()).toBe(200);
    });

    test('arming the kill switch force-signs-out every other session; the arming device stays signed in', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_kick_' + ts;
        const { token, user } = await registerUser(page, uname);

        // Create a SECOND session by logging in as a distinct device.
        const hash = await loginHash(page, uname, 'password123');
        const loginRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: hash, device_id: 'device-b', device_name: 'Device B', duration_seconds: 3600 },
        });
        expect(loginRes.status()).toBe(200);
        const tokenB = (await loginRes.json()).token;
        expect(tokenB).toBeTruthy();

        // Both sessions are live before arming.
        const meA = await page.request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
        const meB = await page.request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
        expect(meA.status()).toBe(200);
        expect(meB.status()).toBe(200);
        expect(dbQuery('SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?1 AND revoked = 0', [user.id])[0][0]).toBe(2);

        // Arm the kill switch with session A.
        expect(await armKillSwitchApi(page, token, 'password123', 'killpass99')).toBe(true);

        // Session B was force-signed-out: its token is rejected and its
        // auth_sessions row is revoked.
        const meBAfter = await page.request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
        expect(meBAfter.status()).toBe(401);
        const rows = dbQuery('SELECT revoked FROM auth_sessions WHERE user_id = ?1', [user.id]) as any[];
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r[0]).sort()).toEqual([0, 1]);

        // Session A (the arming device) is untouched.
        const meAAfter = await page.request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
        expect(meAAfter.status()).toBe(200);

        // The kill switch still works end-to-end: its password deletes the account.
        const proof = await killSwitchProof(page, uname, 'killpass99');
        const delRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: '', kill_switch_proof: proof },
        });
        expect(delRes.status()).toBe(500);
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);
    });

    test('kill-switch login (no 2FA) deletes the account, hidden as a generic server error', async ({ page, browser }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_delete_' + ts;
        const { token, user } = await registerUser(page, uname);
        expect(await armKillSwitchApi(page, token, 'password123', 'killpass99')).toBe(true);

        // Drive the real login page with the kill-switch password. Use a FRESH
        // context: the registered page is logged in, so login.html would
        // redirect it straight back to index.html.
        const ctx = await browser.newContext();
        const loginPage = await ctx.newPage();
        await loginPage.goto(`${BASE}/login.html`);
        await loginPage.fill('#login-username', uname);
        await loginPage.fill('#login-password', 'killpass99');
        await loginPage.click('#login-form button[type="submit"]');
        // The deletion must be hidden — the user sees a generic server error.
        await loginPage.waitForSelector('#error-message', { state: 'visible', timeout: 15000 });
        const errText = await loginPage.evaluate(() => {
            const el = document.getElementById('error-message');
            return el ? el.textContent || '' : '';
        });
        expect(errText).toContain('Internal server error');
        await ctx.close();

        // Account is gone: auth-params 404, login 401, no users row.
        const authParams = await page.request.get(`${BASE}/api/auth-params/${uname}`);
        expect(authParams.status()).toBe(404);
        const realHash = await loginHash(page, uname, 'password123');
        const login = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: realHash },
        });
        expect(login.status()).toBe(401);
        const rows = dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id]);
        expect(rows[0][0]).toBe(0);
    });

    test('kill-switch + 2FA requires the code, then deletes the account hidden as a server error', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_2fa_' + ts;
        const { token, user } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');

        // Enable 2FA via the API (same flow as twofa.spec).
        const enrollRes = await page.request.post(`${BASE}/api/2fa/enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { password: hash },
        });
        expect(enrollRes.status()).toBe(200);
        const enrollData = await enrollRes.json();
        const verifyRes = await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: await totpCode(enrollData.secret_base32) },
        });
        expect(verifyRes.status()).toBe(200);

        expect(await armKillSwitchApi(page, token, 'password123', 'killpass99')).toBe(true);

        // Password step with the kill-switch password → looks like a normal 2FA login.
        const proof = await killSwitchProof(page, uname, 'killpass99');
        const pwRes = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: '', kill_switch_proof: proof },
        });
        expect(pwRes.status()).toBe(200);
        const pwData = await pwRes.json();
        expect(pwData.two_factor_required).toBe(true);
        expect(pwData.pending_token).toBeTruthy();

        // Wrong code → rejected (looks like a failed 2FA login), account intact.
        const badCode = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: pwData.pending_token, code: '000000' },
        });
        expect(badCode.status()).toBe(401);
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(1);

        // Correct code → account deleted, generic server error (deletion hidden).
        const goodCode = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: pwData.pending_token, code: await totpCode(enrollData.secret_base32) },
        });
        expect(goodCode.status()).toBe(500);
        const err = await goodCode.json();
        expect(err.error).toContain('Internal server error');
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);
        const authParams = await page.request.get(`${BASE}/api/auth-params/${uname}`);
        expect(authParams.status()).toBe(404);

        // Replaying the same code/token (e.g. submitting the 2FA form twice)
        // must NOT reveal the deletion — it answers with the SAME generic
        // server error, never "2FA is not enabled for this account".
        const replay = await page.request.post(`${BASE}/api/login/2fa`, {
            headers: { 'Content-Type': 'application/json' },
            data: { pending_token: pwData.pending_token, code: await totpCode(enrollData.secret_base32) },
        });
        expect(replay.status()).toBe(500);
        const replayErr = await replay.json();
        expect(replayErr.error).toContain('Internal server error');
        expect(replayErr.error).not.toContain('2FA');
    });

    test.skip('2FA kill-switch via the real login UI stays hidden as the same generic error', async ({ page, browser }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const uname = 'ks_ui_2fa_' + ts;
        const { token, user } = await registerUser(page, uname);
        const hash = await loginHash(page, uname, 'password123');

        // Enable 2FA via the API, then arm the kill switch.
        const enrollRes = await page.request.post(`${BASE}/api/2fa/enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { password: hash },
        });
        expect(enrollRes.status()).toBe(200);
        const enrollData = await enrollRes.json();
        const verifyRes = await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { code: await totpCode(enrollData.secret_base32) },
        });
        expect(verifyRes.status()).toBe(200);
        expect(await armKillSwitchApi(page, token, 'password123', 'killpass99')).toBe(true);

        // Fresh context: log in with the kill-switch password through the real UI.
        const ctx = await browser.newContext();
        const lp = await ctx.newPage();
        await lp.goto(`${BASE}/login.html`);
        await lp.fill('#login-username', uname);
        await lp.fill('#login-password', 'killpass99');
        await lp.click('#login-form button[type="submit"]');
        // Looks like a normal 2FA login — the code form appears.
        // Kill-switch + 2FA involves Argon2 hashing on the client which can be slow;
        // give extra time for the 2FA form to render.
        await lp.waitForSelector('#login-2fa-form', { state: 'visible', timeout: 60000 });

        // Correct code → the client clears the pending token and returns to the
        // password form with the SAME generic server error surfaced there.
        await lp.fill('#login-2fa-code', await totpCode(enrollData.secret_base32));
        await lp.click('#login-2fa-form button[type="submit"]');
        await lp.waitForSelector('#login-form', { state: 'visible', timeout: 15000 });
        await lp.waitForFunction(() => {
            const err = document.getElementById('error-message');
            return err && err.style.display === 'block' && err.textContent.indexOf('Internal server error') !== -1;
        }, { timeout: 15000 });
        // Nothing on the page reveals 2FA-specific state that would hint the
        // account was deleted.
        const bodyText = await lp.evaluate(() => document.body.textContent || '');
        expect(bodyText).not.toContain('2FA is not enabled');
        await ctx.close();

        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);
    });

    test('settings UI arms and removes the kill switch; disarm makes the kill-switch login a plain failure', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_ui_' + ts;
        const { token, user } = await registerUser(page, uname);

        // Open settings → Security tab → verify OFF by default.
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { timeout: 5000 });
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.waitForSelector('#kill-switch-status-line', { timeout: 5000 });
        await page.waitForFunction(() => {
            const el = document.getElementById('kill-switch-status-line');
            return el && el.textContent && el.textContent.indexOf('OFF') !== -1;
        }, { timeout: 10000 });

        // Arm via the real UI form.
        await page.click('#kill-switch-set-btn');
        await page.fill('#kill-switch-pw', 'killpass99');
        await page.fill('#kill-switch-pw-confirm', 'killpass99');
        await page.fill('#kill-switch-current', 'password123');
        await page.click('#kill-switch-save-btn');
        await page.waitForFunction(() => {
            const el = document.getElementById('kill-switch-status-line');
            return el && el.textContent && el.textContent.indexOf('ON') !== -1;
        }, { timeout: 10000 });

        // Armed: the kill-switch login deletes the account… but first, disarm
        // via the UI (prompt asks for the current password).
        const dialogs: string[] = [];
        page.on('dialog', async (d) => {
            dialogs.push(d.message());
            await d.accept('password123');
        });
        await page.click('#kill-switch-remove-btn');
        await page.waitForFunction(() => {
            const el = document.getElementById('kill-switch-status-line');
            return el && el.textContent && el.textContent.indexOf('OFF') !== -1;
        }, { timeout: 10000 });
        expect(dialogs.length).toBeGreaterThan(0);

        // Disarmed: the kill-switch columns are gone, so no proof can even be
        // produced — the client sends the raw password (legacy path) and the
        // server rejects it as a normal failed login. Account stays intact.
        const after = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: 'killpass99' },
        });
        expect(after.status()).toBe(401);
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(1);

        // Real login still works after disarm.
        const realHash = await loginHash(page, uname, 'password123');
        const ok = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: realHash },
        });
        expect(ok.status()).toBe(200);
    });

    test('delete-account button wipes every table that references the user', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_wipe_' + ts;
        const { token, user } = await registerUser(page, uname);

        // Seed representative rows in every user-referencing table so we can
        // prove delete_user wipes them all.
        const uid = user.id;
        const sid = 'seed_server_' + ts;
        const dm = 'seed_dm_' + ts;
        const ch = 'seed_ch_' + ts;
        const mid = 'seed_msg_' + ts;
        const fid = 'a'.repeat(64);
        dbExec("INSERT OR IGNORE INTO servers (id, owner_id, encrypted_name, name_nonce) VALUES (?1,?2,'x','x')", [sid, uid]);
        dbExec("INSERT OR IGNORE INTO channels (id, server_id, type, encrypted_name, name_nonce, position) VALUES (?1,?2,'text','x','x',0)", [ch, sid]);
        dbExec("INSERT OR IGNORE INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp) VALUES (?1,?2,?3,'x','x',datetime('now'))", [mid, ch, uid]);
        dbExec("INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?1,?2,'owner')", [sid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_channels (id) VALUES (?1)", [dm]);
        dbExec("INSERT OR IGNORE INTO dm_members (dm_channel_id, user_id) VALUES (?1,?2)", [dm, uid]);
        dbExec("INSERT OR IGNORE INTO dm_messages (id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp) VALUES (?1,?2,?3,'x','x',datetime('now'))", ['seed_dmm_' + ts, dm, uid]);
        dbExec("INSERT OR IGNORE INTO friendships (user_id_a, user_id_b) VALUES (?1,'seed_other')", [uid]);
        dbExec("INSERT OR IGNORE INTO friend_requests (from_user_id, to_user_id) VALUES (?1,'seed_other')", [uid]);
        dbExec("INSERT OR IGNORE INTO files (id, uploader_id, original_size, file_id_hash) VALUES (?1,?2,10,'b')", [fid, uid]);
        dbExec("INSERT OR IGNORE INTO totp_secrets (user_id, secret_encrypted, nonce, salt) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO recovery_codes (user_id, code_hash) VALUES (?1,'x')", [uid]);
        dbExec("INSERT OR IGNORE INTO auth_sessions (id, user_id, device_id, device_name, expires_at) VALUES (?1,?2,'d','n',datetime('now'))", ['seed_sess_' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO user_key_blobs (user_id, encrypted_blob, salt, nonce) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO user_key_escrow (user_id, encrypted_private_key, salt, nonce) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO profile_data_keys (user_id, encrypted_key, nonce) VALUES (?1,'x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO shared_profile_data_keys (owner_user_id, target_type, target_id, encrypted_key, nonce) VALUES (?1,'server','t','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO pending_notifications (user_id, notification_type, payload) VALUES (?1,'t','p')", [uid]);
        dbExec("INSERT OR IGNORE INTO pending_events (user_id, event_type) VALUES (?1,'t')", [uid]);
        dbExec("INSERT OR IGNORE INTO message_pins (channel_id, message_id, pinned_by) VALUES (?1,?2,?3)", [ch, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_pins (dm_channel_id, message_id, pinned_by) VALUES (?1,'p',?2)", [dm, uid]);
        dbExec("INSERT OR IGNORE INTO notification_sounds (user_id, encrypted_sound, nonce, sender_public_key) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO ringtones (user_id, encrypted_sound, nonce, sender_public_key) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO voice_participants (voice_session_id, user_id) VALUES (?1, ?2)", ['seed_vs' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO voice_sanctions (server_id, user_id) VALUES (?1, ?2)", [sid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_call_waiting (dm_channel_id, waiting_user_id) VALUES (?1, ?2)", [dm, uid]);
        dbExec("INSERT OR IGNORE INTO conversation_profile_data (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO user_media (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO user_stickers (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO server_bans (server_id, user_id) VALUES (?1, ?2)", [sid, uid]);
        // Reactions / poll votes / read acks (channel + DM) on OTHER users' content.
        dbExec("INSERT OR IGNORE INTO message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1,?2,?3,'e','e','e')", ['seed_rx_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1,?2,?3,'e','e','e')", ['seed_drx_' + ts, 'seed_dmm_' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1,?2,?3,'e')", ['seed_pv_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1,?2,?3,'e')", ['seed_dpv_' + ts, 'seed_dmm_' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1,?2,?3,'read','e')", ['seed_ack_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1,?2,?3,'read','e')", ['seed_dack_' + ts, 'seed_dmm_' + ts, uid]);

        // Delete the account via the settings button flow (DELETE /api/me).
        // Password-gated now — send the client-computed current-password hash.
        const delPw = await page.evaluate(async () => {
            const authKeyB64 = localStorage.getItem('e2e_auth_key');
            const key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(authKeyB64));
            return E2ECrypto.hmacHex(key, 'password123');
        });
        const del = await page.request.delete(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { current_password: delPw },
        });
        expect(del.status()).toBe(200);

        // users row gone, and every seeded table no longer references the user.
        const checks: [string, string, any[]][] = [
            ['users', 'id = ?1', [uid]],
            ['servers', 'owner_id = ?1', [uid]],
            ['channels', 'id = ?1', [ch]],
            ['messages', 'sender_id = ?1', [uid]],
            ['server_members', 'user_id = ?1', [uid]],
            ['dm_channels', 'id = ?1', [dm]],
            ['dm_members', 'user_id = ?1', [uid]],
            ['dm_messages', 'sender_id = ?1', [uid]],
            ['friendships', 'user_id_a = ?1 OR user_id_b = ?1', [uid]],
            ['friend_requests', 'from_user_id = ?1 OR to_user_id = ?1', [uid]],
            ['files', 'uploader_id = ?1', [uid]],
            ['totp_secrets', 'user_id = ?1', [uid]],
            ['recovery_codes', 'user_id = ?1', [uid]],
            ['auth_sessions', 'user_id = ?1', [uid]],
            ['user_key_blobs', 'user_id = ?1', [uid]],
            ['user_key_escrow', 'user_id = ?1', [uid]],
            ['profile_data_keys', 'user_id = ?1', [uid]],
            ['shared_profile_data_keys', 'owner_user_id = ?1', [uid]],
            ['pending_notifications', 'user_id = ?1', [uid]],
            ['pending_events', 'user_id = ?1 OR affected_user_id = ?1', [uid]],
            ['message_pins', 'pinned_by = ?1', [uid]],
            ['dm_message_pins', 'pinned_by = ?1', [uid]],
            ['notification_sounds', 'user_id = ?1', [uid]],
            ['ringtones', 'user_id = ?1', [uid]],
            ['voice_participants', 'user_id = ?1', [uid]],
            ['voice_sanctions', 'user_id = ?1', [uid]],
            ['dm_call_waiting', 'waiting_user_id = ?1', [uid]],
            ['conversation_profile_data', 'user_id = ?1', [uid]],
            ['user_media', 'user_id = ?1', [uid]],
            ['user_stickers', 'user_id = ?1', [uid]],
            ['server_bans', 'user_id = ?1', [uid]],
            ['message_reactions', 'reactor_id = ?1', [uid]],
            ['dm_message_reactions', 'reactor_id = ?1', [uid]],
            ['message_poll_votes', 'voter_id = ?1', [uid]],
            ['dm_message_poll_votes', 'voter_id = ?1', [uid]],
            ['message_acks', 'acker_id = ?1', [uid]],
            ['dm_message_acks', 'acker_id = ?1', [uid]],
        ];
        for (const [table, where, args] of checks) {
            const n = dbQuery(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, args)[0][0] as number;
            expect(n, `${table} still references the deleted user`).toBe(0);
        }
    });

    test('delete-account requires the current password; wrong password leaves the account intact', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_del_pw_' + ts;
        const { token, user } = await registerUser(page, uname);

        // Wrong password → rejected, account still exists.
        const wrong = await page.request.delete(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { current_password: 'a'.repeat(64) },
        });
        expect(wrong.status()).toBe(401);
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(1);

        // Correct password → deleted.
        const delPw = await page.evaluate(async () => {
            const authKeyB64 = localStorage.getItem('e2e_auth_key');
            const key = new Uint8Array(E2ECrypto.base64ToArrayBuffer(authKeyB64));
            return E2ECrypto.hmacHex(key, 'password123');
        });
        const ok = await page.request.delete(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { current_password: delPw },
        });
        expect(ok.status()).toBe(200);
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);

        // The deleted account can no longer log in at all.
        const login = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: uname, password: delPw },
        });
        expect(login.status()).toBe(401);
    });

    test('settings UI deletes the account through the password-gated form', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'ks_ui_del_' + ts;
        const { token, user } = await registerUser(page, uname);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { timeout: 5000 });
        await page.click('.settings-tab[data-tab="security-settings"]');
        await page.waitForSelector('#delete-account-btn', { timeout: 5000 });

        // Open the section, fill a wrong password, cancel (clears the input).
        await page.click('#delete-account-btn');
        await page.waitForSelector('#delete-account-section', { state: 'visible', timeout: 5000 });
        await page.fill('#delete-account-password', 'wrongpass');
        await page.click('#delete-account-cancel-btn');
        await page.waitForSelector('#delete-account-section', { state: 'hidden', timeout: 5000 });

        // Reopen, fill the real password, confirm (dismiss the two confirm dialogs).
        page.on('dialog', async (d) => d.accept());
        await page.click('#delete-account-btn');
        await page.fill('#delete-account-password', 'password123');
        await page.click('#delete-account-confirm-btn');
        await page.waitForURL('**/login.html', { timeout: 15000 });
        expect(dbQuery('SELECT COUNT(*) FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);
    });
});

test.describe('Kill Switch rate limiting (isolated server)', () => {
    let child: ChildProcess;
    let tmpDb: string;
    // Ports 3454/3455 (G2 uses 3450/3451, admin-runtime-config uses
    // 3452/3453) so isolated suites can run side by side.
    const ALT = 'https://127.0.0.1:3455';

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `ks-rl-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: '3454',
                HTTPS_PORT: '3455',
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                // Tiny per-IP kill-switch budget so the throttle trips
                // deterministically; the per-account budget raised so this
                // server isolates the per-IP limiter.
                KILL_SWITCH_IP_MAX: '3',
                KILL_SWITCH_USER_MAX: '100000',
                // Everything else raised so only the kill-switch limiter fires.
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
                REGISTER_IP_MAX: '100000',
                LOGIN_2FA_IP_MAX: '100000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await request.get(`${ALT}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'isolated server came up').toBe(true);
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
        }
    });

    test('kill-switch proof attempts are throttled per IP, indistinguishable from a normal login rate-limit', async ({ request }) => {
        test.setTimeout(120000);
        // Fresh DB → the first admin login sets up the admin password.
        const setup = await request.post(`${ALT}/api/admin/login`, { data: { password: 'hardening' } });
        expect(setup.ok(), 'admin setup on isolated server').toBeTruthy();

        const proof = 'a'.repeat(64);
        // First 3 proof attempts are allowed — each is just a plain failed login.
        for (let i = 0; i < 3; i++) {
            const r = await request.post(`${ALT}/api/login`, {
                headers: { 'Content-Type': 'application/json' },
                data: { username: 'nobody', password: '', kill_switch_proof: proof },
            });
            expect(r.status(), `proof attempt ${i + 1} should be a plain 401`).toBe(401);
        }
        // The 4th trips the kill-switch budget with EXACTLY the same response
        // as the general login rate-limit — nothing reveals a kill switch.
        const blocked = await request.post(`${ALT}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: 'nobody', password: '', kill_switch_proof: proof },
        });
        expect(blocked.status()).toBe(429);
        const err = await blocked.json();
        expect(err.error).toBe('Too many login attempts. Try again in 5 minutes.');

        // The throttle only gates proof-carrying requests: a normal login from
        // the same client still reaches the server (a plain 401 for a bogus
        // user) instead of being blocked.
        const normal = await request.post(`${ALT}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username: 'nobody2', password: 'whatever' },
        });
        expect(normal.status()).toBe(401);
    });
});

test.describe('Kill Switch per-account rate limiting (isolated server)', () => {
    let child: ChildProcess;
    let tmpDb: string;
    // Ports 3456/3457 (other isolated suites use 3445/3451/3453/3455) so
    // isolated suites can run side by side.
    const ALT = 'https://127.0.0.1:3457';

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `ks-user-rl-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: '3456',
                HTTPS_PORT: '3457',
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                // Tiny per-ACCOUNT kill-switch budget so the throttle trips
                // deterministically regardless of where requests come from.
                KILL_SWITCH_USER_MAX: '3',
                // Per-IP kill-switch budget raised so THIS server isolates the
                // per-account limiter: even requests from many different IPs
                // (simulated with X-Forwarded-For) share the account budget.
                KILL_SWITCH_IP_MAX: '100000',
                // Everything else raised so only the kill-switch limiter fires.
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
                REGISTER_IP_MAX: '100000',
                LOGIN_2FA_IP_MAX: '100000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await request.get(`${ALT}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'isolated server came up').toBe(true);
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
        }
    });

    test('kill-switch proof attempts are throttled per account even when spread across many IPs', async ({ request }) => {
        test.setTimeout(120000);
        // Fresh DB → the first admin login sets up the admin password.
        const setup = await request.post(`${ALT}/api/admin/login`, { data: { password: 'hardening' } });
        expect(setup.ok(), 'admin setup on isolated server').toBeTruthy();

        const proof = 'a'.repeat(64);
        // First 3 proof attempts against the SAME target account are allowed
        // (each is just a plain failed login) — even though every request
        // comes from a DIFFERENT IP, so the per-IP limiter can't catch them.
        for (let i = 0; i < 3; i++) {
            const r = await request.post(`${ALT}/api/login`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': `203.0.113.${10 + i}`, // distinct fake IPs
                },
                data: { username: 'target_account', password: '', kill_switch_proof: proof },
            });
            expect(r.status(), `proof attempt ${i + 1} from a new IP should be a plain 401`).toBe(401);
        }
        // The 4th attempt — again from a brand-new IP — trips the per-ACCOUNT
        // budget with EXACTLY the same response as the general login rate-limit.
        const blocked = await request.post(`${ALT}/api/login`, {
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '203.0.113.99',
            },
            data: { username: 'target_account', password: '', kill_switch_proof: proof },
        });
        expect(blocked.status()).toBe(429);
        const err = await blocked.json();
        expect(err.error).toBe('Too many login attempts. Try again in 5 minutes.');

        // A DIFFERENT account is not affected by the target's budget: a proof
        // for another username (from yet another IP) still reaches the server.
        const other = await request.post(`${ALT}/api/login`, {
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.7',
            },
            data: { username: 'other_account', password: '', kill_switch_proof: proof },
        });
        expect(other.status()).toBe(401);

        // And a normal login for the throttled account is NOT blocked by the
        // kill-switch budget — only proof-carrying requests are throttled.
        const normal = await request.post(`${ALT}/api/login`, {
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.8' },
            data: { username: 'target_account', password: 'whatever' },
        });
        expect(normal.status()).toBe(401);
    });
});
