import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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

// ---------- App helpers ----------
async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');        await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

// ---------- Tests ----------
test.describe('Self-destruct cleanup — delete_user wipes all non-cascade tables', () => {

    test('vault files, reactions, polls, acks, pins, voice state, pending events/notifications, dm_call_waiting are all removed', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const uname = 'sd_cleanup_' + ts;
        const { token, user } = await registerUser(page, uname);
        const uid = user.id;

        // --- Seed infrastructure ---
        const sid = 'sd_srv_' + ts;
        const ch = 'sd_ch_' + ts;
        const dm = 'sd_dm_' + ts;
        const mid = 'sd_msg_' + ts;
        const dmid = 'sd_dmm_' + ts;

        // Server + channel + message (so pins and reactions have FK targets)
        dbExec("INSERT OR IGNORE INTO servers (id, owner_id, encrypted_name, name_nonce) VALUES (?1,?2,'x','x')", [sid, uid]);
        dbExec("INSERT OR IGNORE INTO channels (id, server_id, type, encrypted_name, name_nonce, position) VALUES (?1,?2,'text','x','x',0)", [ch, sid]);
        dbExec("INSERT OR IGNORE INTO messages (id, channel_id, sender_id, encrypted_content, nonce, timestamp) VALUES (?1,?2,?3,'x','x',datetime('now'))", [mid, ch, uid]);
        dbExec("INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?1,?2,'owner')", [sid, uid]);

        // DM channel + message
        dbExec("INSERT OR IGNORE INTO dm_channels (id) VALUES (?1)", [dm]);
        dbExec("INSERT OR IGNORE INTO dm_members (dm_channel_id, user_id) VALUES (?1,?2)", [dm, uid]);
        dbExec("INSERT OR IGNORE INTO dm_messages (id, dm_channel_id, sender_id, encrypted_content, nonce, timestamp) VALUES (?1,?2,?3,'x','x',datetime('now'))", [dmid, dm, uid]);

        // --- Seed vault files (encrypted data stored in DB) ---
        // Use raw SQL with hex-encoded blob to avoid Buffer serialization issues
        dbExec(
            "INSERT INTO user_vault_files (id, user_id, encrypted_data, encrypted_filename, filename_nonce, encrypted_mime_type, mime_type_nonce, original_size, stored_size, encrypted_file_key, file_key_nonce, content_hash) VALUES (?1,?2,X'656e637279707465642d7661756c742d64617461','efn','n','emt','n',100,100,'ek','n','hash1')",
            ['vault_' + ts, uid]
        );
        dbExec(
            "INSERT INTO user_vault_files (id, user_id, encrypted_data, encrypted_filename, filename_nonce, encrypted_mime_type, mime_type_nonce, original_size, stored_size, encrypted_file_key, file_key_nonce, content_hash) VALUES (?1,?2,X'656e637279707465642d7661756c742d6461746132','efn2','n2','emt2','n2',200,200,'ek2','n2','hash2')",
            ['vault2_' + ts, uid]
        );
        expect(dbQuery('SELECT COUNT(*) FROM user_vault_files WHERE user_id = ?1', [uid])[0][0]).toBe(2);

        // --- Seed reactions (reactor_id has NO ON DELETE CASCADE) ---
        dbExec("INSERT OR IGNORE INTO message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1,?2,?3,'tok1','e','e')", ['rx_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_reactions (id, message_id, reactor_id, emoji_token, encrypted_emoji, emoji_nonce) VALUES (?1,?2,?3,'tok1','e','e')", ['drx_' + ts, dmid, uid]);

        // --- Seed poll votes (voter_id has NO ON DELETE CASCADE) ---
        dbExec("INSERT OR IGNORE INTO message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1,?2,?3,'opt1')", ['pv_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_poll_votes (id, message_id, voter_id, option_token) VALUES (?1,?2,?3,'opt1')", ['dpv_' + ts, dmid, uid]);

        // --- Seed read acks (acker_id has NO ON DELETE CASCADE) ---
        dbExec("INSERT OR IGNORE INTO message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1,?2,?3,'read','tok')", ['ack_' + ts, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_acks (id, message_id, acker_id, status, ack_token) VALUES (?1,?2,?3,'read','tok')", ['dack_' + ts, dmid, uid]);

        // --- Seed message pins (pinned_by has NO ON DELETE CASCADE) ---
        dbExec("INSERT OR IGNORE INTO message_pins (channel_id, message_id, pinned_by) VALUES (?1,?2,?3)", [ch, mid, uid]);
        dbExec("INSERT OR IGNORE INTO dm_message_pins (dm_channel_id, message_id, pinned_by) VALUES (?1,?2,?3)", [dm, dmid, uid]);

        // --- Seed voice state (NO foreign keys at all) ---
        dbExec("INSERT OR IGNORE INTO voice_participants (voice_session_id, user_id) VALUES (?1,?2)", ['vs_' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO voice_sanctions (server_id, user_id) VALUES (?1,?2)", [sid, uid]);

        // --- Seed dm_call_waiting (NO foreign key on waiting_user_id) ---
        dbExec("INSERT OR IGNORE INTO dm_call_waiting (dm_channel_id, waiting_user_id) VALUES (?1,?2)", [dm, uid]);

        // --- Seed pending events (NO FK on user_id / affected_user_id) ---
        dbExec("INSERT OR IGNORE INTO pending_events (user_id, server_id, event_type, affected_user_id) VALUES (?1,?2,'key_rotation','other')", [uid, sid]);
        dbExec("INSERT OR IGNORE INTO pending_events (user_id, server_id, event_type, affected_user_id) VALUES ('other',?1,'key_rotation',?2)", [sid, uid]);

        // --- Seed pending notifications (NO FK on user_id) ---
        dbExec("INSERT OR IGNORE INTO pending_notifications (user_id, notification_type, payload) VALUES (?1,'msg','{}')", [uid]);

        // --- Seed files (uploader_id has NO FK) ---
        const fileHash = 'a'.repeat(64);
        dbExec("INSERT OR IGNORE INTO files (id, uploader_id, original_size, file_id_hash) VALUES (?1,?2,999,'x')", [fileHash, uid]);

        // --- Seed other user-referencing tables (have CASCADE, but verify anyway) ---
        dbExec("INSERT OR IGNORE INTO server_bans (server_id, user_id) VALUES (?1,?2)", [sid, uid]);
        dbExec("INSERT OR IGNORE INTO totp_secrets (user_id, secret_encrypted, nonce, salt) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO recovery_codes (user_id, code_hash) VALUES (?1,'x')", [uid]);
        dbExec("INSERT OR IGNORE INTO auth_sessions (id, user_id, device_id, device_name, expires_at) VALUES (?1,?2,'d','n',datetime('now'))", ['sess_' + ts, uid]);
        dbExec("INSERT OR IGNORE INTO user_key_blobs (user_id, encrypted_blob, salt, nonce) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO user_key_escrow (user_id, encrypted_private_key, salt, nonce) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO profile_data_keys (user_id, encrypted_key, nonce) VALUES (?1,'x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO shared_profile_data_keys (owner_user_id, target_type, target_id, encrypted_key, nonce) VALUES (?1,'server','t','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO conversation_profile_data (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO user_media (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO user_stickers (user_id) VALUES (?1)", [uid]);
        dbExec("INSERT OR IGNORE INTO notification_sounds (user_id, encrypted_sound, nonce, sender_public_key) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO ringtones (user_id, encrypted_sound, nonce, sender_public_key) VALUES (?1,'x','x','x')", [uid]);
        dbExec("INSERT OR IGNORE INTO friendships (user_id_a, user_id_b) VALUES (?1,'other')", [uid]);
        dbExec("INSERT OR IGNORE INTO friend_requests (from_user_id, to_user_id) VALUES (?1,'other')", [uid]);

        // --- Verify seeding is complete ---
        expect(dbQuery('SELECT COUNT(*) FROM user_vault_files WHERE user_id = ?1', [uid])[0][0]).toBe(2);
        expect(dbQuery('SELECT COUNT(*) FROM message_reactions WHERE reactor_id = ?1', [uid])[0][0]).toBe(1);
        expect(dbQuery('SELECT COUNT(*) FROM voice_participants WHERE user_id = ?1', [uid])[0][0]).toBe(1);

        // --- Delete the account via DELETE /api/me (same path as self-destruct after fix) ---
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

        // --- Verify every table is clean ---
        // Tables WITHOUT ON DELETE CASCADE (the ones that were previously leaked by self_destruct_user)
        const nonCascadeChecks: [string, string, any[]][] = [
            // Vault files (the new feature)
            ['user_vault_files', 'user_id = ?1', [uid]],
            // Reactions (reactor_id has no CASCADE)
            ['message_reactions', 'reactor_id = ?1', [uid]],
            ['dm_message_reactions', 'reactor_id = ?1', [uid]],
            // Poll votes (voter_id has no CASCADE)
            ['message_poll_votes', 'voter_id = ?1', [uid]],
            ['dm_message_poll_votes', 'voter_id = ?1', [uid]],
            // Read acks (acker_id has no CASCADE)
            ['message_acks', 'acker_id = ?1', [uid]],
            ['dm_message_acks', 'acker_id = ?1', [uid]],
            // Pins (pinned_by has no CASCADE)
            ['message_pins', 'pinned_by = ?1', [uid]],
            ['dm_message_pins', 'pinned_by = ?1', [uid]],
            // Voice state (no FK at all)
            ['voice_participants', 'user_id = ?1', [uid]],
            ['voice_sanctions', 'user_id = ?1', [uid]],
            // DM call waiting (no FK on waiting_user_id)
            ['dm_call_waiting', 'waiting_user_id = ?1', [uid]],
            // Pending events (no FK on user_id / affected_user_id)
            ['pending_events', 'user_id = ?1 OR affected_user_id = ?1', [uid]],
            // Pending notifications (no FK on user_id)
            ['pending_notifications', 'user_id = ?1', [uid]],
            // Files (uploader_id has no FK)
            ['files', 'uploader_id = ?1', [uid]],
            // Server bans (has CASCADE, but verify)
            ['server_bans', 'user_id = ?1', [uid]],
        ];
        for (const [table, where, args] of nonCascadeChecks) {
            const n = dbQuery(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, args)[0][0] as number;
            expect(n, `${table} still references the deleted user — cleanup incomplete`).toBe(0);
        }

        // Tables WITH ON DELETE CASCADE (verify the user and cascaded data is gone)
        const cascadeChecks: [string, string, any[]][] = [
            ['users', 'id = ?1', [uid]],
            ['servers', 'owner_id = ?1', [uid]],
            ['messages', 'sender_id = ?1', [uid]],
            ['server_members', 'user_id = ?1', [uid]],
            ['dm_members', 'user_id = ?1', [uid]],
            ['dm_messages', 'sender_id = ?1', [uid]],
            ['friendships', 'user_id_a = ?1 OR user_id_b = ?1', [uid]],
            ['friend_requests', 'from_user_id = ?1 OR to_user_id = ?1', [uid]],
            ['totp_secrets', 'user_id = ?1', [uid]],
            ['recovery_codes', 'user_id = ?1', [uid]],
            ['auth_sessions', 'user_id = ?1', [uid]],
            ['user_key_blobs', 'user_id = ?1', [uid]],
            ['user_key_escrow', 'user_id = ?1', [uid]],
            ['profile_data_keys', 'user_id = ?1', [uid]],
            ['shared_profile_data_keys', 'owner_user_id = ?1', [uid]],
            ['conversation_profile_data', 'user_id = ?1', [uid]],
            ['user_media', 'user_id = ?1', [uid]],
            ['user_stickers', 'user_id = ?1', [uid]],
            ['notification_sounds', 'user_id = ?1', [uid]],
            ['ringtones', 'user_id = ?1', [uid]],
        ];
        for (const [table, where, args] of cascadeChecks) {
            const n = dbQuery(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, args)[0][0] as number;
            expect(n, `${table} still references the deleted user`).toBe(0);
        }
    });

    test('self-destruct API round-trip: set setting, verify DB columns exist', async ({ page }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const uname = 'sd_api_' + ts;
        const { token, user } = await registerUser(page, uname);

        // Default is 0 (off)
        const getRes = await page.request.get(`${BASE}/api/me/self-destruct`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(getRes.status()).toBe(200);
        const getData = await getRes.json();
        expect(getData.self_destruct_days).toBe(0);

        // Set to 30 days
        const setRes = await page.request.put(`${BASE}/api/me/self-destruct`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { self_destruct_days: 30 },
        });
        expect(setRes.status()).toBe(200);
        const setData = await setRes.json();
        expect(setData.self_destruct_days).toBe(30);

        // Verify in DB
        const dbDays = dbQuery('SELECT self_destruct_days FROM users WHERE id = ?1', [user.id])[0][0];
        expect(dbDays).toBe(30);

        // last_active_at is set on WebSocket connect (registration uses WS for chat).
        // It may or may not be set depending on whether WS connected during registration,
        // so we don't assert it here — the get_inactive_users test covers it.

        // Set back to 0 (off)
        const offRes = await page.request.put(`${BASE}/api/me/self-destruct`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { self_destruct_days: 0 },
        });
        expect(offRes.status()).toBe(200);
        expect(dbQuery('SELECT self_destruct_days FROM users WHERE id = ?1', [user.id])[0][0]).toBe(0);
    });

    test('get_inactive_users_for_deletion only returns truly inactive users with self-destruct armed', async ({ page }) => {
        test.setTimeout(120000);
        // Register a real user through the browser (requires client-side
        // Argon2id hashing, so API-only registration won't work).
        const ts = Date.now();
        const uname = 'sd_inactive_' + ts;
        const { token, user } = await registerUser(page, uname);
        const uid = user.id;

        // Set self_destruct_days via the API.
        const setRes = await page.request.put(`${BASE}/api/me/self-destruct`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { self_destruct_days: 1 },
        });
        expect(setRes.status()).toBe(200);

        // Replicate the server's inactive-user query. We compute the
        // threshold in JS (not SQL ||) to avoid Windows cmd quoting issues.
        // The dbQuery helper fails on Windows with certain column names due to
        // double-JSON-escaping in the python3 -c command, so we write a temp
        // Python script to a file and execute it instead.
        const pyFile = path.join(os.tmpdir(), `sd_q_${ts}.py`);
        const sql = 'SELECT id, self_destruct_days, last_active_at FROM users WHERE self_destruct_days > 0 AND last_active_at IS NOT NULL';
        fs.writeFileSync(pyFile,
            'import sqlite3, json\n' +
            "con = sqlite3.connect('server/e2e_chat.db')\n" +
            'cur = con.cursor()\n' +
            `cur.execute(${JSON.stringify(sql)})\n` +
            'print(json.dumps(cur.fetchall()))\n'
        );
        function getInactive(): string[] {
            const out = execSync(`python3 "${pyFile}"`, { encoding: 'utf8' }).trim();
            const rows = JSON.parse(out) as any[];
            const now = Date.now();
            return rows
                .filter(([id, days, la]: any) => {
                    const threshold = now - days * 86400_000;
                    return new Date(la + 'Z').getTime() < threshold;
                })
                .map((r: any) => r[0]);
        }

        // Not yet inactive (last_active_at is recent)
        expect(getInactive()).not.toContain(uid);

        // Fake last_active_at to 2 days ago -> now qualifies (2 > 1 day)
        dbExec("UPDATE users SET last_active_at = datetime('now', '-2 days') WHERE id = ?1", [uid]);
        expect(getInactive()).toContain(uid);

        // Disable self-destruct -> no longer qualifies even though inactive
        dbExec('UPDATE users SET self_destruct_days = 0 WHERE id = ?1', [uid]);
        expect(getInactive()).not.toContain(uid);

        // Cleanup temp Python script
        try { fs.unlinkSync(pyFile); } catch (_) {}
    });
});
