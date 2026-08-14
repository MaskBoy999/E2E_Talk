import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = 'https://localhost:3443';
const DB = 'server/e2e_chat.db';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

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

// NOTE: (0, eval) works inside page.evaluate but NOT inside page.waitForFunction
// (the app's CSP blocks the string-eval Playwright uses there), so poll via
// evaluate. The fn must be self-contained (Playwright serializes it without
// closure scope) — pass any data via the arg.
async function waitFor<T>(page: Page, fn: (arg: T) => boolean, arg: T, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            if (await page.evaluate(fn, arg)) return;
        } catch (e) {
            console.log('waitFor evaluate threw:', String(e).slice(0, 120));
            throw e;
        }
        await page.waitForTimeout(300);
    }
    throw new Error('waitFor timed out');
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    return page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
        friendCode: localStorage.getItem('e2e_friend_code'),
    }));
}

// Capture incoming WS frames so we can assert what the server actually sends.
async function installWsCapture(context: BrowserContext) {
    await context.addInitScript(() => {
        (window as any).__wsFrames = [];
        const OrigWS = window.WebSocket;
        (window as any).__OrigWS = OrigWS;
        (window as any).WebSocket = class extends OrigWS {
            constructor(...args: any[]) {
                super(...(args as [string, string?]));
                this.addEventListener('message', (ev: MessageEvent) => {
                    try {
                        const msg = JSON.parse(ev.data);
                        (window as any).__wsFrames.push({
                            dir: 'in',
                            type: msg.type,
                            notification_type: msg.notification_type || null,
                            hasEncPayload: !!msg.encrypted_payload,
                            hasChannelId: msg.channel_id !== undefined,
                            hasServerId: msg.server_id !== undefined,
                            hasMessageId: msg.message_id !== undefined,
                        });
                    } catch {
                        (window as any).__wsFrames.push({ dir: 'in', raw: String(ev.data).slice(0, 80) });
                    }
                });
            }
        };
        (window as any).WebSocket.prototype = OrigWS.prototype;
    });
}

test.describe('B2 — live mention relay is E2E encrypted', () => {
    test('mentioned online user receives an encrypted_notification envelope, never plaintext', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'b2a_' + ts;
        const userB = 'b2b_' + ts;

        const bodyA = await register(page, userA);

        const ctxB = await context.browser()!.newContext();
        await installWsCapture(ctxB);
        const pageB = await ctxB.newPage();
        const bodyB = await register(pageB, userB);

        // Server for A, B joins via invite.
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
            data: { name: 'B2 Server', invite_code: inviteCode },
        });
        const server = await srvRes.json();
        expect(server.id).toBeTruthy();

        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: bodyA.user.id });

        await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        });
        const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBe(true);

        // Upload server key for B so A can encrypt to the channel.
        const userBPub = await pageB.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
        await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, user2Id: bodyB.user.id, user2PubKey: userBPub });

        // Load both into the channel.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });

        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await pageB.click('.server-icon:not(.add-server)');
        await pageB.waitForSelector('.channel-item', { timeout: 10000 });
        await pageB.click('.channel-item >> nth=0');
        await expect(pageB.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        await pageB.waitForTimeout(1000);

        // Wait until A's client sees B in the member list and its WS is open
        // (sendMessage silently drops messages while the socket is connecting).
        await waitFor(page, (uname) => {
            const list = (0, eval)('currentServerMemberList');
            const sock = (0, eval)('ws');
            return Array.isArray(list) && list.some((m: any) => m.username === uname) && sock && sock.readyState === 1;
        }, userB);

        // A mentions B.
        await page.fill('#message-input', '@' + userB + ' hello from the encrypted relay');
        await page.click('#send-btn');
        await page.waitForTimeout(2500);

        // The mention must have rendered (decrypt + dispatch worked).
        await expect(pageB.locator('.message.mentioned').first()).toBeVisible({ timeout: 8000 });

        const frames = await pageB.evaluate(() => (window as any).__wsFrames || []);
        const inFrames = frames.filter((f: any) => f.dir === 'in');
        const mentionFrames = inFrames.filter((f: any) => f.type === 'mention_notification');
        const encFrames = inFrames.filter((f: any) => f.type === 'encrypted_notification');

        // No plaintext mention relay with routing ids.
        expect(mentionFrames.length).toBe(0);

        // An encrypted envelope arrived, with a blinded type and no plaintext ids.
        expect(encFrames.length).toBeGreaterThanOrEqual(1);
        const enc = encFrames[encFrames.length - 1];
        expect(enc.hasEncPayload).toBe(true);
        expect(enc.notification_type).toMatch(/^[a-f0-9]{64}$/);
        expect(enc.hasChannelId).toBe(false);
        expect(enc.hasServerId).toBe(false);
        expect(enc.hasMessageId).toBe(false);

        await pageB.close();
        await ctxB.close();
    });
});

test.describe('B4 — offline queued notifications are blinded', () => {
    test('pending_notifications stores an HMAC type and ECDH-encrypted payload', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const userA = 'b4a_' + ts;
        const userB = 'b4b_' + ts;

        const bodyA = await register(page, userA);

        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        const bodyB = await register(pageB, userB);
        const bUserId = bodyB.user.id;

        // Server for A, B joins, then B goes offline.
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
            data: { name: 'B4 Server', invite_code: inviteCode },
        });
        const server = await srvRes.json();
        await page.evaluate(async ({ serverId, userId }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, userId: bodyA.user.id });
        await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${bodyA.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: inviteCode },
        });
        const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${bodyB.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBe(true);
        // B uploads nothing more — B is offline when the mention is sent.
        await pageB.close();
        await ctxB.close();
        await page.waitForTimeout(500);

        // A loads the channel and mentions offline B.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });
        // Wait until A's client sees B in the member list and its WS is open
        // (sendMessage silently drops messages while the socket is connecting).
        await waitFor(page, (uname) => {
            const list = (0, eval)('currentServerMemberList');
            const sock = (0, eval)('ws');
            return Array.isArray(list) && list.some((m: any) => m.username === uname) && sock && sock.readyState === 1;
        }, userB);
        await page.fill('#message-input', '@' + userB + ' offline mention');
        await page.click('#send-btn');
        await page.waitForTimeout(2500);

        // The pending notification for B must be blind type + ECDH payload.
        const rows = dbQuery(
            'SELECT notification_type, payload FROM pending_notifications WHERE user_id = ?1 ORDER BY id DESC LIMIT 5',
            [bUserId],
        ) as [string, string][];
        const mentionRow = rows.find((r) => r[0] && r[0].length === 64);
        expect(mentionRow, 'expected a blinded mention notification row').toBeTruthy();
        if (!mentionRow) return;
        expect(mentionRow[0]).toMatch(/^[a-f0-9]{64}$/);
        const parts = mentionRow[1].split(':');
        expect(parts.length).toBe(3);
        expect(parts[0].length).toBeGreaterThanOrEqual(40); // ephemeral pubkey b64
        expect(parts[1].length).toBeGreaterThanOrEqual(30); // nonce b64
        expect(parts[2].length).toBeGreaterThanOrEqual(20); // ciphertext b64

        // Clean up this user's queue so later assertions aren't polluted.
        dbExec('DELETE FROM pending_notifications WHERE user_id = ?1', [bUserId]);
    });
});

test.describe('B5 — admin audit IP redaction', () => {
    test('with redaction on, audit entries store *.*.*.*; off restores the real IP', async ({ page, request }) => {
        test.setTimeout(60000);
        // Force a known admin password: save the old hash, clear it so the next
        // login is "setup", and RESTORE it afterwards so other admin suites
        // (G4) keep their pre-existing password state.
        const oldHashRows = dbQuery("SELECT value FROM admin_config WHERE key = 'password_hash'");
        const oldHash: string | null = (oldHashRows as any)[0]?.[0] ?? null;
        dbExec("DELETE FROM admin_config WHERE key = 'password_hash'");

        // First login sets the password (setup mode) and returns a token.
        let res = await request.post(`${BASE}/api/admin/login`, { data: { password: 'b5testadmin' } });
        expect(res.status()).toBeLessThan(300);
        let body = await res.json();
        let token = body.token;
        if (!token) {
            // Password was already set: this was a plain login.
            token = body.token;
        }
        expect(token).toBeTruthy();

        const put = async (redact: boolean) => {
            const res = await request.put(`${BASE}/api/admin/runtime-config`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { admin_audit_redact_ips: redact },
            });
            expect(res.status(), `redact=${redact} put status`).toBeLessThan(300);
        };

        // With redaction ON, trigger a logged action (the PUT itself logs one).
        await put(true);
        await page.waitForTimeout(500);
        let rows = await (await request.get(`${BASE}/api/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } })).json() as any[];
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const newestOn = rows[0];
        expect(newestOn.ip).toBe('*.*.*.*');

        // With redaction OFF, the next action logs a real IP.
        await put(false);
        await page.waitForTimeout(500);
        rows = await (await request.get(`${BASE}/api/admin/audit-log`, { headers: { Authorization: `Bearer ${token}` } })).json() as any[];
        const newestOff = rows[0];
        expect(newestOff.ip).not.toBe('*.*.*.*');
        expect(newestOff.ip).toBeTruthy();

        // Restore the original admin password hash (cleanup for other suites).
        if (oldHash) {
            dbExec("INSERT OR REPLACE INTO admin_config (key, value) VALUES ('password_hash', ?1)", [oldHash]);
        } else {
            dbExec("DELETE FROM admin_config WHERE key = 'password_hash'");
        }
    });
});
