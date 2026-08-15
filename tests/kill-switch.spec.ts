import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';

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

        // Delete the account via the settings button flow (DELETE /api/me).
        const del = await page.request.delete(`${BASE}/api/me`, {
            headers: { Authorization: `Bearer ${token}` },
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
        ];
        for (const [table, where, args] of checks) {
            const n = dbQuery(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, args)[0][0] as number;
            expect(n, `${table} still references the deleted user`).toBe(0);
        }
    });
});
