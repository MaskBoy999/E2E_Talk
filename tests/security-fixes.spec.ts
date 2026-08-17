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

// The exact credential the client sends at login: HMAC-SHA256(hash_key, password).
async function loginHash(page: Page, username: string, password: string): Promise<string> {
    return page.evaluate(async ({ username, password }) => {
        const res = await fetch('/api/auth-params/' + encodeURIComponent(username));
        const params = await res.json();
        const hashKeyB64 = E2ECrypto.decryptWithPassword(
            params.encrypted_hash_key, password,
            params.hash_key_salt, params.hash_key_nonce,
        );
        const hashKeyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(hashKeyB64));
        return E2ECrypto.hmacHex(hashKeyBytes, password);
    }, { username, password });
}

test.describe('H3: pass-the-hash (server-side password verifier)', () => {
    test('stored credential is a server verifier, not a replayable hash', async ({ page, request }) => {
        const uname = 'h3a_' + Date.now();
        const { token, user } = await registerUser(page, uname);
        expect(token).toBeTruthy();

        // The DB must hold a server-side verifier ($e2e$ + Argon2id), never the
        // client credential verbatim.
        const rows = dbQuery('SELECT password_hash FROM users WHERE id = ?1', [user.id]);
        expect(rows.length).toBe(1);
        const stored = rows[0][0] as string;
        expect(stored.startsWith('$e2e$')).toBe(true);
        const credential = await loginHash(page, uname, 'password123');
        expect(stored).not.toBe(credential);

        // Pass-the-hash replay: sending the STORED value as the password must fail.
        const replay = await request.post(`${BASE}/api/login`, {
            data: { username: uname, password: stored },
        });
        expect(replay.status()).toBe(401);

        // The real credential still logs in.
        const ok = await request.post(`${BASE}/api/login`, {
            data: { username: uname, password: credential },
        });
        expect(ok.status()).toBe(200);
    });

    test('legacy bare-credential rows self-upgrade on first successful login', async ({ page, request }) => {
        const uname = 'h3b_' + Date.now();
        const { user } = await registerUser(page, uname);
        const credential = await loginHash(page, uname, 'password123');

        // Simulate an account created before the fix: stored value is the bare
        // client credential (the old insecure scheme).
        dbExec('UPDATE users SET password_hash = ?1 WHERE id = ?2', [credential, user.id]);
        expect(dbQuery('SELECT password_hash FROM users WHERE id = ?1', [user.id])[0][0]).toBe(credential);

        // First successful login upgrades it in place to the $e2e$ verifier.
        const ok = await request.post(`${BASE}/api/login`, {
            data: { username: uname, password: credential },
        });
        expect(ok.status()).toBe(200);
        const upgraded = dbQuery('SELECT password_hash FROM users WHERE id = ?1', [user.id])[0][0] as string;
        expect(upgraded.startsWith('$e2e$')).toBe(true);
        expect(upgraded).not.toBe(credential);

        // And now the stored value is NOT replayable either.
        const replay = await request.post(`${BASE}/api/login`, {
            data: { username: uname, password: upgraded },
        });
        expect(replay.status()).toBe(401);
    });
});

test.describe('H4: presence + username lookup require auth', () => {
    test('unauthenticated /api/online and /api/user/{name} are rejected; authed work', async ({ page, request }) => {
        const uname = 'h4_' + Date.now();
        const anonOnline = await request.get(`${BASE}/api/online`);
        expect(anonOnline.status()).toBe(401);

        const anonUser = await request.get(`${BASE}/api/user/${uname}`);
        expect(anonUser.status()).toBe(401);

        const { token, user } = await registerUser(page, uname);
        // The page's WS registers the user as online shortly after load.
        await expect.poll(async () => {
            const authedOnline = await request.get(`${BASE}/api/online`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (authedOnline.status() !== 200) return null;
            const ids = await authedOnline.json();
            return Array.isArray(ids) && ids.includes(user.id) ? ids : null;
        }, { timeout: 10000 }).not.toBeNull();

        const authedUser = await request.get(`${BASE}/api/user/${uname}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(authedUser.status()).toBe(200);
        expect((await authedUser.json()).id).toBe(user.id);
    });
});

test.describe('H1: upload size enforcement', () => {
    test('chunk uploads cannot exceed the declared size (per-chunk + cumulative)', async ({ page, request }) => {
        const { token } = await registerUser(page, 'h1_' + Date.now());
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

        // Declare a tiny file (4 bytes).
        const init = await request.post(`${BASE}/api/files/init`, {
            headers: auth,
            data: { size: 4, mime: 'application/octet-stream' },
        });
        expect(init.status()).toBe(200);
        const { file_id } = await init.json();

        const chunkHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' };
        const postChunk = (i: number, bytes: number) =>
            request.post(`${BASE}/api/files/${file_id}/chunk/${i}`, {
                headers: chunkHeaders,
                data: Buffer.alloc(bytes),
            });

        // Per-chunk cap: a single chunk over 1 MiB is rejected outright.
        expect((await postChunk(0, 2 * 1024 * 1024)).status()).toBe(413);

        // Cumulative cap: allowed = 4 + 64 = 68 bytes total. 200 > 68 → 413.
        expect((await postChunk(0, 200)).status()).toBe(413);

        // Legit small chunk (44 = 4 plaintext + 40 AEAD overhead) → OK.
        expect((await postChunk(0, 44)).status()).toBe(200);

        // Second chunk would push the total to 88 > 68 → rejected.
        expect((await postChunk(1, 44)).status()).toBe(413);

        // A second chunk sized to land exactly at the cap (44 + 24 = 68) → OK.
        expect((await postChunk(1, 24)).status()).toBe(200);

        // Overwriting chunk 1 with a larger payload pushes 68 - 24 + 100 = 144
        // > 68 → rejected (overwrites adjust, they don't add).
        expect((await postChunk(1, 100)).status()).toBe(413);

        // Complete succeeds: chunk_bytes (68) matches the declared range.
        const complete = await request.post(`${BASE}/api/files/${file_id}/complete`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(complete.status()).toBe(200);
        expect(dbQuery('SELECT chunk_bytes FROM files WHERE id = ?1', [file_id])[0][0]).toBe(68);
    });

    test('complete rejects when on-disk bytes disagree with the declared size', async ({ page, request }) => {
        const { token } = await registerUser(page, 'h1b_' + Date.now());
        const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const init = await request.post(`${BASE}/api/files/init`, {
            headers: auth,
            data: { size: 4, mime: 'application/octet-stream' },
        });
        const { file_id } = await init.json();
        const chunkHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' };
        expect((await request.post(`${BASE}/api/files/${file_id}/chunk/0`, {
            headers: chunkHeaders, data: Buffer.alloc(44),
        })).status()).toBe(200);

        // Simulate a server restart that lost the incremental meter: bump the
        // on-disk accounting far past the declared size, then complete.
        dbExec('UPDATE files SET chunk_bytes = 5000 WHERE id = ?1', [file_id]);
        const complete = await request.post(`${BASE}/api/files/${file_id}/complete`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(complete.status()).toBe(400);
    });
});
