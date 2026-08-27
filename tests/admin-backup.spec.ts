import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

// Isolated server (ports 3458/3459 — other isolated suites use 3445–3457).
const PORT = '3458';
const HTTPS_PORT = '3459';
const ALT = `https://127.0.0.1:${HTTPS_PORT}`;
const ADMIN_PW = 'backup-admin';

async function loginAdminPage(page: Page, base: string = ALT, adminPw: string = ADMIN_PW) {
    // An import just reloaded the page — the first goto can be interrupted by
    // that in-flight navigation. Retry once instead of failing the test.
    try {
        await page.goto(`${base}/admin.html`);
    } catch (_) {
        await page.waitForTimeout(1200);
        await page.goto(`${base}/admin.html`);
    }
    await page.waitForSelector('#admin-login-form', { timeout: 10000 });
    await page.fill('#admin-password', adminPw);
    await page.click('#admin-login-btn');
    // A freshly-wiped DB is in setup mode: the first click SETS the password
    // ("Password set! Now login with it.") and a second login is required.
    const panel = page.locator('#admin-panel');
    try {
        await panel.waitFor({ state: 'visible', timeout: 4000 });
    } catch (_) {
        await page.fill('#admin-password', adminPw);
        await page.click('#admin-login-btn');
        await expect(panel).toBeVisible({ timeout: 10000 });
    }
}

test.describe('Admin backup encryption + raw tables (isolated server)', () => {
    let child: ChildProcess;
    let tmpDb: string;

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `admin-bk-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT,
                HTTPS_PORT,
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                REGISTER_IP_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
                LOGIN_2FA_IP_MAX: '100000',                KILL_SWITCH_IP_MAX: '100000', KILL_SWITCH_USER_MAX: '100000',
                // The admin login rate limiter (10/5min default) would throttle
                // the many logins this suite performs on one shared server.
                ADMIN_LOGIN_IP_MAX: '100000',
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
        // First login sets up the admin password.
        const setup = await request.post(`${ALT}/api/admin/login`, { data: { password: ADMIN_PW } });
        expect(setup.ok(), 'admin setup on isolated server').toBeTruthy();
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
        }
    });

    test('raw tables browser reflects the current schema and renders real rows', async ({ page, request }) => {
        test.setTimeout(120000);
        await loginAdminPage(page);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        expect(token).toBeTruthy();

        // Every new-feature table is browsable via the generic endpoint.
        const newTables = ['message_reactions', 'dm_message_reactions', 'message_acks', 'dm_message_acks',
            'message_poll_votes', 'dm_message_poll_votes', 'message_pins', 'dm_message_pins',
            'message_search_tokens', 'dm_message_search_tokens', 'ringtones', 'recovery_codes',
            'totp_secrets', 'voice_sanctions', 'dm_call_waiting', 'user_key_blobs', 'admin_audit'];
        for (const t of newTables) {
            const r = await request.get(`${ALT}/api/admin/table/${t}`, {
                headers: { Authorization: 'Bearer ' + token },
            });
            expect(r.status(), `table ${t}`).toBe(200);
            const body = await r.json();
            expect(Array.isArray(body.columns), `columns for ${t}`).toBe(true);
        }
        // Unknown table → 400.
        const bad = await request.get(`${ALT}/api/admin/table/nope_missing_table`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        expect(bad.status()).toBe(400);

        // UI: the Raw Tables tab lists every table, including new feature tables.
        await page.click('.tab-btn[data-tab="raw-tables"]');
        await page.waitForSelector('#raw-tables-list .tab-btn', { timeout: 10000 });
        const listText = await page.locator('#raw-tables-list').textContent();
        for (const t of ['users', 'files', 'messages', 'message_reactions', 'message_acks',
            'message_poll_votes', 'dm_message_reactions', 'ringtones', 'recovery_codes', 'auth_sessions']) {
            expect(listText, `tables list contains ${t}`).toContain(t);
        }

        // Opening a populated table renders actual rows (admin_config has the
        // admin password hash after setup).
        await page.click('[data-raw-table="admin_config"]');
        await page.waitForSelector('#raw-table-head th', { timeout: 10000 });
        const headText = await page.locator('#raw-table-head').textContent();
        expect(headText).toContain('key');
        const bodyRows = await page.locator('#raw-table-body tr').count();
        expect(bodyRows).toBeGreaterThan(0);
    });

    test('password-encrypted export is Argon2id (v2) and round-trips; wrong password rejected', async ({ page, request }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        await loginAdminPage(page);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';

        // Audit log has entries (admin_login) before export.
        const auditBefore = await (await request.get(`${ALT}/api/admin/audit-log`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        expect(auditBefore.length).toBeGreaterThan(0);

        // Export with a password → v2 (magic 0x02).
        const outPath = path.join(__dirname, '..', 'test-results', 'admin-v2.dbpack');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.click('#export-db-btn');
        await page.fill('#export-password-input', 'backup-pass');
        await page.fill('#export-password-confirm-input', 'backup-pass');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(outPath);
        const buf = fs.readFileSync(outPath);
        expect(buf[0], 'v2 magic byte').toBe(0x02);

        // Decrypt in-page with the app's own Argon2id helpers: the file is a
        // real SQLite DB (salt 16 @1, nonce 24 @17, ciphertext @41).
        const decryptedB64 = await page.evaluate(async (b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const toB64 = (u8: Uint8Array) => {
                let s = '';
                for (let i = 0; i < u8.length; i += 0x8000) {
                    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                }
                return btoa(s);
            };
            const saltB64 = toB64(bytes.slice(1, 17));
            const nonceB64 = toB64(bytes.slice(17, 41));
            const ctB64 = toB64(bytes.slice(41));
            return E2ECrypto.decryptWithPassword(ctB64, 'backup-pass', saltB64, nonceB64);
        }, buf.toString('base64'));
        expect(decryptedB64, 'decryptable with the right password').not.toBeNull();
        const decrypted = Buffer.from(decryptedB64!, 'base64');
        // New exports are a bundle: [0xDB][u32 db_len][SQLite DB][uploads].
        expect(decrypted[0], 'bundle magic byte').toBe(0xDB);
        const dbLen = decrypted.readUInt32LE(1);
        const dbPart = decrypted.subarray(5, 5 + dbLen);
        // The 16-byte SQLite header ends with a NUL.
        expect(dbPart.subarray(0, 15).toString()).toBe('SQLite format 3');
        expect(decrypted.length, 'uploads bundle present after the DB').toBeGreaterThan(5 + dbLen + 4);

        // Wrong password → import rejected, DB untouched (admin login still works).
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser.setFiles(outPath);
        // The confirm modal appears first; checkbox off = direct import.
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.click('#continue-import-confirm');
        await page.waitForSelector('#import-db-password-modal', { state: 'visible', timeout: 10000 });
        await page.fill('#import-password-input', 'wrongpass');
        await page.click('#confirm-import-db');
        await expect.poll(() => dialogs.join('|'), { timeout: 20000 }).toContain('Wrong password');
        const loginAfterWrong = await request.post(`${ALT}/api/admin/login`, { data: { password: ADMIN_PW } });
        expect(loginAfterWrong.ok(), 'DB intact after wrong password').toBeTruthy();

        // Correct password → import succeeds and the page reloads.
        const [chooser2] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser2.setFiles(outPath);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.click('#continue-import-confirm');
        await page.waitForSelector('#import-db-password-modal', { state: 'visible', timeout: 10000 });
        await page.fill('#import-password-input', 'backup-pass');
        await page.click('#confirm-import-db');
        await expect.poll(() => dialogs.join('|'), { timeout: 30000 }).toContain('imported successfully');

        // Re-login: the imported DB preserved admin_config + audit rows.
        await loginAdminPage(page);
        const token2 = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        const auditAfter = await (await request.get(`${ALT}/api/admin/audit-log`, {
            headers: { Authorization: 'Bearer ' + token2 },
        })).json();
        expect(auditAfter.length, 'audit rows survived the round trip').toBeGreaterThan(0);
    });

    test('Validate Backup (dry run) checks a file without touching the live DB', async ({ page, request }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        await loginAdminPage(page);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';

        // Live DB has data right now.
        const before = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        const usersBefore = ((before.find((t: any) => t.name === 'users') || {}).count) || 0;
        const auditBefore = ((before.find((t: any) => t.name === 'admin_audit') || {}).count) || 0;
        expect(usersBefore + auditBefore, 'live DB has rows before dry run').toBeGreaterThan(0);

        // Export an unencrypted backup of the CURRENT db.
        const outPath = path.join(__dirname, '..', 'test-results', 'admin-dryrun.dbpack');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.click('#export-db-btn');
        await page.click('#export-db-nopw');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(outPath);
        const buf = fs.readFileSync(outPath);
        expect(buf[0], 'unencrypted magic byte').toBe(0x00);

        // Validate via the UI: pick the backup, expect the results modal.
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#validate-db-btn'),
        ]);
        await chooser.setFiles(outPath);
        await page.waitForSelector('#import-results-modal', { state: 'visible', timeout: 10000 });
        const summary = await page.locator('#import-results-summary').textContent();
        expect(summary).toContain('Integrity check passed');
        expect(summary).toContain('total');
        const rowsText = await page.locator('#import-results-body').textContent();
        expect(rowsText).toContain('users');
        expect(rowsText).toContain('admin_audit');
        // Per-table size estimates are rendered (B/KB/MB).
        const sizeCells = await page.locator('#import-results-body td:nth-child(3)').allTextContents();
        const sizey = sizeCells.filter((s) => /\d+ (B|KB|MB)/.test(s));
        expect(sizey.length, 'size column populated for most tables').toBeGreaterThan(sizeCells.length / 2);

        // Clicking a table row previews its columns + rows (read-only dry run).
        await page.locator('#import-results-body tr[data-import-preview="users"]').click();
        await page.waitForSelector('#import-preview-modal', { state: 'visible', timeout: 10000 });
        const previewTitle = await page.locator('#import-preview-title').textContent();
        expect(previewTitle).toBe('users');
        const headText = await page.locator('#import-preview-head').textContent();
        expect(headText).toContain('username');
        expect(headText).toContain('id');
        const previewRows = await page.locator('#import-preview-body tr').count();
        expect(previewRows).toBeGreaterThan(0);
        await page.click('#close-import-preview');
        await expect(page.locator('#import-preview-modal')).toBeHidden();

        // The live DB is still untouched after the previews.
        await page.click('#close-import-results');
        await expect(page.locator('#import-results-modal')).toBeHidden();

        // The dry run must NOT have replaced anything: admin still logged in
        // (no re-login needed) and every table keeps its rows.
        expect(await page.evaluate(() => sessionStorage.getItem('admin_auth'))).toBe('true');
        const after = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        const usersAfter = ((after.find((t: any) => t.name === 'users') || {}).count) || 0;
        const auditAfter = ((after.find((t: any) => t.name === 'admin_audit') || {}).count) || 0;
        expect(usersAfter, 'users intact after dry run').toBe(usersBefore);
        // The audit log only grows (the export itself is audited) — the dry run
        // must never reduce it, which a replaced DB would.
        expect(auditAfter, 'audit never reduced after dry run').toBeGreaterThanOrEqual(auditBefore);

        // API level: a dry_run request on a valid file returns integrity + tables.
        // (New exports embed the DB inside a bundle — extract the DB part first,
        // exactly like admin.js does before POSTing to import-db.)
        const unencrypted = Buffer.from(buf.subarray(1));
        const dbPart = unencrypted[0] === 0xDB
            ? unencrypted.subarray(5, 5 + unencrypted.readUInt32LE(1))
            : unencrypted;
        const res = await request.post(`${ALT}/api/admin/import-db?dry_run=1`, {
            headers: { Authorization: 'Bearer ' + token },
            data: dbPart,
        });
        expect(res.status(), 'dry-run POST ok').toBe(200);
        const body = await res.json();
        expect(body.dry_run).toBe(true);
        expect(body.integrity_ok).toBe(true);
        expect(Array.isArray(body.tables)).toBe(true);
        expect(body.tables.length).toBeGreaterThan(5);
        // Per-table sizes + total DB size are reported.
        expect(typeof body.total_size_bytes, 'total size is a number').toBe('number');
        expect(body.total_size_bytes).toBeGreaterThan(0);
        const withSize = body.tables.filter((t: any) => typeof t.size_bytes === 'number');
        expect(withSize.length, 'dbstat sizes for most tables').toBeGreaterThan(body.tables.length / 2);
        // The file-size total is authoritative; per-table sums are approximate
        // (indexes are folded in), so just require a sane bound.
        const sumOfSizes = withSize.reduce((s: number, t: any) => s + (t.size_bytes || 0), 0);
        expect(sumOfSizes, 'sum of table sizes within 2x of file total').toBeLessThanOrEqual(body.total_size_bytes * 2);

        // API level: corrupt input is rejected and still leaves the DB alone.
        const bad = Buffer.alloc(1024, 0x41);
        bad.write('SQLite format 3\x00', 0);
        const badRes = await request.post(`${ALT}/api/admin/import-db?dry_run=1`, {
            headers: { Authorization: 'Bearer ' + token },
            data: bad,
        });
        expect(badRes.status(), 'corrupt dry-run rejected').toBe(400);
        const afterBad = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        expect((afterBad.find((t: any) => t.name === 'users') || {}).count || 0, 'still intact after bad dry run').toBe(usersBefore);
    });

    test('legacy v1 (SHA-256 + AES-GCM) encrypted backups still import', async ({ page }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        await loginAdminPage(page);

        // The no-password checkbox is the explicit way to export unencrypted:
        // it hides the password fields and updates the hint.
        const plainPath = path.join(__dirname, '..', 'test-results', 'admin-plain.dbpack');
        fs.mkdirSync(path.dirname(plainPath), { recursive: true });
        await page.click('#export-db-btn');
        await expect(page.locator('#export-db-fields')).toBeVisible();
        expect(await page.locator('#export-db-hint').textContent()).toContain('Argon2id');
        await page.check('#export-db-nopw');
        await expect(page.locator('#export-db-fields')).toBeHidden();
        expect(await page.locator('#export-db-hint').textContent()).toContain('unencrypted');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(plainPath);
        const plain = fs.readFileSync(plainPath);
        expect(plain[0], 'unencrypted export magic 0x00').toBe(0x00);

        // Importing a 0x00 file goes straight through with no password prompt.
        const [plainChooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await plainChooser.setFiles(plainPath);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.click('#continue-import-confirm');
        await expect(page.locator('#import-db-password-modal')).toBeHidden({ timeout: 5000 });
        await expect.poll(() => dialogs.join('|'), { timeout: 20000 }).toContain('imported successfully');

        // The import reloaded the page and cleared the session — log back in.
        await loginAdminPage(page);

        // Re-wrap with the legacy v1 scheme (SHA-256-derived AES-GCM).
        const v1B64 = await page.evaluate(async (dbB64) => {
            const db = Uint8Array.from(atob(dbB64), (c) => c.charCodeAt(0)).slice(1);
            const saltBytes = crypto.getRandomValues(new Uint8Array(16));
            const salt = Array.from(saltBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
            const material = 'legacy-pass:' + salt;
            const pwHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
            const key = await crypto.subtle.importKey('raw', pwHash, { name: 'AES-GCM' }, false, ['encrypt']);
            const nonce = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, db);
            const combined = new Uint8Array(1 + 16 + 12 + encrypted.byteLength);
            combined[0] = 0x01;
            combined.set(saltBytes, 1);
            combined.set(nonce, 17);
            combined.set(new Uint8Array(encrypted), 29);
            let s = '';
            for (let i = 0; i < combined.length; i += 0x8000) {
                s += String.fromCharCode.apply(null, combined.subarray(i, i + 0x8000));
            }
            return btoa(s);
        }, plain.toString('base64'));

        const v1Path = path.join(__dirname, '..', 'test-results', 'admin-v1.dbpack');
        fs.writeFileSync(v1Path, Buffer.from(v1B64, 'base64'));
        expect(fs.readFileSync(v1Path)[0]).toBe(0x01);

        // Import it with the legacy password → success.
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser.setFiles(v1Path);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.click('#continue-import-confirm');
        await page.waitForSelector('#import-db-password-modal', { state: 'visible', timeout: 10000 });
        await page.fill('#import-password-input', 'legacy-pass');
        await page.click('#confirm-import-db');
        await expect.poll(() => dialogs.join('|'), { timeout: 30000 }).toContain('imported successfully');
    });

    test('“Validate before importing” dry-runs then imports the same backup in one flow', async ({ page, request }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        await loginAdminPage(page);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';

        // Export a fresh encrypted backup of the current DB.
        const outPath = path.join(__dirname, '..', 'test-results', 'admin-validate-first.dbpack');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.click('#export-db-btn');
        await page.fill('#export-password-input', 'vf-pass');
        await page.fill('#export-password-confirm-input', 'vf-pass');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(outPath);
        expect(fs.readFileSync(outPath)[0], 'encrypted magic 0x02').toBe(0x02);

        // Import with the validate-first checkbox ticked.
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser.setFiles(outPath);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.check('#import-validate-first');
        await page.click('#continue-import-confirm');

        // Password modal → dry run runs, results modal offers Import this backup.
        await page.waitForSelector('#import-db-password-modal', { state: 'visible', timeout: 10000 });
        await page.fill('#import-password-input', 'vf-pass');
        await page.click('#confirm-import-db');
        await page.waitForSelector('#import-results-modal', { state: 'visible', timeout: 20000 });
        const summary = await page.locator('#import-results-summary').textContent();
        expect(summary).toContain('Integrity check passed');
        await expect(page.locator('#import-from-results')).toBeVisible();

        // Still on the live DB: nothing replaced yet.
        expect(await page.evaluate(() => sessionStorage.getItem('admin_auth'))).toBe('true');
        const mid = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        expect(((mid.find((t: any) => t.name === 'users') || {}).count) || 0, 'users before final import').toBeGreaterThanOrEqual(0);

        // Import this backup → real import succeeds and reloads.
        await page.click('#import-from-results');
        await expect.poll(() => dialogs.join('|'), { timeout: 30000 }).toContain('imported successfully');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);

        // Re-login works on the imported DB.
        await loginAdminPage(page);
        const token2 = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        const after = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token2 },
        })).json();
        expect(after.length).toBeGreaterThan(5);
    });

    test('a backup that fails the dry run is blocked until IMPORT is typed', async ({ page, request }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        await loginAdminPage(page);

        // Export an unencrypted backup, then corrupt the freelist header so
        // PRAGMA integrity_check fails (still a valid openable SQLite file).
        const outPath = path.join(__dirname, '..', 'test-results', 'admin-risky.dbpack');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.click('#export-db-btn');
        await page.click('#export-db-nopw');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(outPath);
        const clean = Buffer.from(fs.readFileSync(outPath).subarray(1));
        // The DB sits at offset 5 inside the bundle (0xDB + u32 len); the SQLite
        // freelist trunk page number is at DB offset 32 → bundle offset 37.
        clean.writeUInt32BE(999999, clean[0] === 0xDB ? 5 + 32 : 32); // freelist trunk page → invalid
        const riskyPath = path.join(__dirname, '..', 'test-results', 'admin-risky-corrupt.dbpack');
        fs.writeFileSync(riskyPath, Buffer.concat([Buffer.from([0x00]), clean]));

        // Import with validate-first: dry run reports problems, results show
        // the Import this backup button while the live DB stays untouched.
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser.setFiles(riskyPath);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.check('#import-validate-first');
        await page.click('#continue-import-confirm');
        await page.waitForSelector('#import-results-modal', { state: 'visible', timeout: 20000 });
        const summary = await page.locator('#import-results-summary').textContent();
        expect(summary).toContain('Integrity check found problems');
        await expect(page.locator('#import-from-results')).toBeVisible();

        // No password modal appeared (unencrypted), admin still logged in.
        expect(await page.evaluate(() => sessionStorage.getItem('admin_auth'))).toBe('true');

        // Import this backup → typed-word guard appears; wrong text stays disabled.
        await page.click('#import-from-results');
        await page.waitForSelector('#risky-import-modal', { state: 'visible', timeout: 10000 });
        const riskyBtn = page.locator('#confirm-risky-import');
        await expect(riskyBtn).toBeDisabled();
        await page.fill('#risky-import-input', 'import');
        await expect(riskyBtn).toBeDisabled();
        await page.fill('#risky-import-input', 'IMPORT ');
        await expect(riskyBtn).toBeDisabled();
        await page.fill('#risky-import-input', 'IMPORT');
        await expect(riskyBtn).toBeEnabled();

        // Confirm → the corrupt backup actually imports and reloads.
        await riskyBtn.click();
        await expect.poll(() => dialogs.join('|'), { timeout: 30000 }).toContain('imported successfully');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);

        // The imported (corrupt) DB reconnects and admin can log back in.
        await loginAdminPage(page);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        expect(token).toBeTruthy();
        const after = await (await request.get(`${ALT}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        expect(after.length).toBeGreaterThan(5);
    });
});

test.describe('Clear-all wipes EVERY table (isolated server)', () => {
    let child: ChildProcess;
    let tmpDb: string;
    const WIPE_PORT = '3460';
    const WIPE_HTTPS = '3461';
    const WIPE = `https://127.0.0.1:${WIPE_HTTPS}`;
    const WIPE_ADMIN = 'wipe-admin';

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `admin-wipe-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: WIPE_PORT,
                HTTPS_PORT: WIPE_HTTPS,
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                LOGIN_IP_MAX: '100000', LOGIN_USER_MAX: '100000', REGISTER_IP_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000', HMAC_KEY_IP_MAX: '100000', LOGIN_2FA_IP_MAX: '100000',
                KILL_SWITCH_IP_MAX: '100000', KILL_SWITCH_USER_MAX: '100000',
                // The admin login rate limiter (10/5min default) would throttle
                // the repeated logins this suite performs on one shared server.
                ADMIN_LOGIN_IP_MAX: '100000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await request.get(`${WIPE}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) {}
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'wipe isolated server came up').toBe(true);
        const setup = await request.post(`${WIPE}/api/admin/login`, { data: { password: WIPE_ADMIN } });
        expect(setup.ok(), 'wipe server admin setup').toBeTruthy();
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
        }
    });

    test('wipe removes rows from every table (incl. admin_audit, reactions, acks, ringtones)', async ({ page, request }) => {
        test.setTimeout(180000);
        // Register a real user, create a server, open a channel and send a message,
        // so users/servers/channels/messages/files carry rows before the wipe.
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const username = `wipe_${ts}`;
        await page.goto(`${WIPE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'TestPass123!');
        await page.fill('#register-confirm-password', 'TestPass123!');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page.fill('#new-server-name', 'Wipe Server');
        await page.click('#confirm-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.locator('.server-icon').filter({ hasText: 'W' }).click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('.channel-item', { timeout: 5000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(500);
        await page.fill('#message-input', 'hello wipe');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);

        // Login to the admin panel and confirm rows exist in feature tables.
        await loginAdminPage(page, WIPE, WIPE_ADMIN);
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        const before = await (await request.get(`${WIPE}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        const countOf = (name: string) => (before.find((t: any) => t.name === name) || {}).count || 0;
        expect(countOf('users'), 'users rows').toBeGreaterThan(0);
        expect(countOf('servers'), 'servers rows').toBeGreaterThan(0);
        expect(countOf('channels'), 'channels rows').toBeGreaterThan(0);
        expect(countOf('messages'), 'messages rows').toBeGreaterThan(0);
        expect(countOf('admin_config'), 'admin_config rows').toBeGreaterThan(0);
        expect(countOf('admin_audit'), 'admin_audit rows (login logged)').toBeGreaterThan(0);
        expect(countOf('files'), 'files rows (message attachments may exist)').toBeGreaterThanOrEqual(0);

        // Wipe everything.
        const wipe = await request.post(`${WIPE}/api/admin/clear`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        expect(wipe.ok(), 'clear-all succeeds').toBeTruthy();

        // The wipe removed admin auth too → the next login re-runs setup.
        const setup1 = await request.post(`${WIPE}/api/admin/login`, { data: { password: WIPE_ADMIN } });
        expect(setup1.ok(), 're-setup after wipe').toBeTruthy();
        const login = await request.post(`${WIPE}/api/admin/login`, { data: { password: WIPE_ADMIN } });
        expect(login.ok(), 'login with the re-set password').toBeTruthy();
        const token2 = ((await login.json()) as any).token as string;
        expect(token2).toBeTruthy();

        // Every table is now empty — including tables the old hardcoded wipe missed.
        const after = await (await request.get(`${WIPE}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token2 },
        })).json();
        expect(after.length).toBeGreaterThan(10);
        for (const t of after) {
            // admin_audit gets the post-wipe login entries; admin_config gets
            // the freshly re-set password — both are legitimately non-empty.
            if ((t as any).name === 'admin_audit' || (t as any).name === 'admin_config') continue;
            expect((t as any).count, `table ${(t as any).name} is empty after wipe`).toBe(0);
        }
        const audit = after.find((t: any) => t.name === 'admin_audit') as any;
        expect(audit.count, 'only the post-wipe logins are audited').toBeGreaterThanOrEqual(2);
        const cfg = after.find((t: any) => t.name === 'admin_config') as any;
        expect(cfg.count, 'admin_config holds only the fresh setup password').toBeGreaterThanOrEqual(1);
    });

    test('wipe requires typing DELETE — cancel keeps data, typed confirm wipes and signs out', async ({ page, request }) => {
        test.setTimeout(180000);
        // Re-login to the admin panel (the API wipe test re-set the password).
        await loginAdminPage(page, WIPE, WIPE_ADMIN);

        // Register a user so there is real data to protect.
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const username = `wui_${ts}`;
        await page.goto(`${WIPE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'TestPass123!');
        await page.fill('#register-confirm-password', 'TestPass123!');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });

        // Back to the admin panel.
        await loginAdminPage(page, WIPE, WIPE_ADMIN);
        const confirmBtn = page.locator('#confirm-wipe-all');
        const input = page.locator('#wipe-confirm-input');

        // Open the wipe modal: confirm is disabled until DELETE is typed.
        await page.click('#clear-all-btn');
        await expect(page.locator('#wipe-confirm-modal')).toBeVisible();
        await expect(confirmBtn).toBeDisabled();

        // Wrong text stays disabled.
        await input.fill('delete');
        await expect(confirmBtn).toBeDisabled();
        await input.fill('DElETE ');
        await expect(confirmBtn).toBeDisabled();

        // Exact DELETE enables the button.
        await input.fill('DELETE');
        await expect(confirmBtn).toBeEnabled();

        // Cancel: nothing is wiped, user still exists.
        await page.click('#cancel-wipe-confirm');
        await expect(page.locator('#wipe-confirm-modal')).toBeHidden();
        const token = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        const afterCancel = await (await request.get(`${WIPE}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token },
        })).json();
        const usersAfterCancel = ((afterCancel.find((t: any) => t.name === 'users') || {}).count) || 0;
        expect(usersAfterCancel, 'user survives the cancelled wipe').toBeGreaterThan(0);

        // Reopen, type DELETE, confirm → wipe executes and admin auth is cleared.
        await page.click('#clear-all-btn');
        await expect(page.locator('#wipe-confirm-modal')).toBeVisible();
        await input.fill('DELETE');
        await confirmBtn.click();
        // The client redirects to login.html, but the server (setup_complete=false
        // after the wipe) 302s that back to admin.html — the admin setup page.
        // The URL never changes (it was already admin.html), so wait for the
        // login card to reappear instead of waiting on a navigation.
        await expect(page.locator('#admin-login')).toBeVisible({ timeout: 15000 });
        expect(await page.evaluate(() => sessionStorage.getItem('admin_auth'))).toBeNull();
        expect(await page.evaluate(() => sessionStorage.getItem('admin_token'))).toBeNull();

        // All tables are now empty (only the audit entries from re-setup remain).
        const setup1 = await request.post(`${WIPE}/api/admin/login`, { data: { password: WIPE_ADMIN } });
        expect(setup1.ok(), 're-setup after UI wipe').toBeTruthy();
        const login = await request.post(`${WIPE}/api/admin/login`, { data: { password: WIPE_ADMIN } });
        const token2 = ((await login.json()) as any).token as string;
        const afterWipe = await (await request.get(`${WIPE}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token2 },
        })).json();
        for (const t of afterWipe) {
            if ((t as any).name === 'admin_audit' || (t as any).name === 'admin_config') continue;
            expect((t as any).count, `table ${(t as any).name} empty after UI wipe`).toBe(0);
        }
    });
});

// ============================================================
// Uploads round-trip: an export → wipe → import must restore the
// uploaded file BYTES too. This is the fix for "pictures lost with
// only their name remaining" after a DB-only backup/restore.
test.describe('Admin backup restores uploaded files (isolated server)', () => {
    let child: ChildProcess;
    let tmpDb: string;
    const UP_PORT = '3462';
    const UP_HTTPS = '3463';
    const UP = `https://127.0.0.1:${UP_HTTPS}`;
    const UP_ADMIN = 'up-admin';

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `admin-up-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: UP_PORT,
                HTTPS_PORT: UP_HTTPS,
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                LOGIN_IP_MAX: '100000', LOGIN_USER_MAX: '100000', REGISTER_IP_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000', HMAC_KEY_IP_MAX: '100000', LOGIN_2FA_IP_MAX: '100000',
                KILL_SWITCH_IP_MAX: '100000', KILL_SWITCH_USER_MAX: '100000',
                ADMIN_LOGIN_IP_MAX: '100000',
                FILE_STORAGE_QUOTA_BYTES: '100000000000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await request.get(`${UP}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'uploads isolated server came up').toBe(true);
        const setup = await request.post(`${UP}/api/admin/login`, { data: { password: UP_ADMIN } });
        expect(setup.ok(), 'admin setup on uploads server').toBeTruthy();
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

    test('export → wipe → import restores the uploaded file bytes', async ({ page, request }) => {
        test.setTimeout(240000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

        // 1. Register a real user on the isolated server.
        const ts = Date.now().toString(36);
        const username = 'up_user_' + ts;
        await page.goto(`${UP}/login.html`);
        await page.waitForTimeout(500);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 20000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1500);
        const token = (await page.evaluate(() => localStorage.getItem('token'))) || '';

        // 2. Upload a file via the API (raw chunk bytes are stored verbatim).
        const pngBytes = Buffer.from(
            '89504e470d0a1a0a' + // PNG signature
            '0000000d49484452000000010000000108020000009077' +
            '53de0000000c4944415408d763f8cfc000000301010018dd' +
            '8db0f20000000049454e44ae426082', 'hex');
        const init = await request.post(`${UP}/api/files/init`, {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            data: { size: pngBytes.length, mime: 'image/png' },
        });
        expect(init.ok(), 'file init').toBeTruthy();
        const { file_id } = await init.json();
        const chunk = await request.post(`${UP}/api/files/${file_id}/chunk/0`, {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
            data: pngBytes,
        });
        expect(chunk.ok(), 'chunk upload').toBeTruthy();
        const done = await request.post(`${UP}/api/files/${file_id}/complete`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        expect(done.ok(), 'complete upload').toBeTruthy();
        const dl0 = await request.get(`${UP}/api/files/${file_id}/download`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        expect(dl0.status(), 'download before wipe').toBe(200);
        expect(Buffer.from(await dl0.body()).equals(pngBytes), 'bytes match before wipe').toBe(true);

        // 3. Admin exports an unencrypted backup (includes the uploads bundle).
        await loginAdminPage(page, UP, UP_ADMIN);
        const outPath = path.join(__dirname, '..', 'test-results', 'admin-up-roundtrip.dbpack');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.click('#export-db-btn');
        await page.click('#export-db-nopw');
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#confirm-export-db'),
        ]);
        await download.saveAs(outPath);
        const pack = fs.readFileSync(outPath);
        expect(pack[0], 'unencrypted magic 0x00').toBe(0x00);
        const payload = Buffer.from(pack.subarray(1));
        expect(payload[0], 'bundle magic').toBe(0xDB);
        const dbLen = payload.readUInt32LE(1);
        const uploadsBundle = payload.subarray(5 + dbLen);
        expect(uploadsBundle.length, 'uploads bundle non-empty').toBeGreaterThan(4);

        // 4. Wipe everything (uploads dir + all rows).
        const adminTok = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        expect(adminTok, 'admin token present for wipe').toBeTruthy();
        const wipe = await request.post(`${UP}/api/admin/clear`, {
            headers: { Authorization: 'Bearer ' + adminTok },
        });
        expect(wipe.status(), 'wipe accepted').toBe(200);

        // The wipe cleared the admin token and the DB — re-setup the admin
        // password (first-time setup screen) before importing.
        await loginAdminPage(page, UP, UP_ADMIN);

        // 5. Import the backup through the UI (no password → straight import).
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click('#import-db-btn'),
        ]);
        await chooser.setFiles(outPath);
        await page.waitForSelector('#import-confirm-modal', { state: 'visible', timeout: 10000 });
        await page.click('#continue-import-confirm');
        await expect.poll(() => dialogs.join('|'), { timeout: 40000 }).toContain('imported successfully');
        // The import reloads the page (admin.js window.location.reload) — let it
        // settle before navigating again, or the goto races the reload.
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);

        // 6. Re-login admin, then verify the file bytes came back.
        await loginAdminPage(page, UP, UP_ADMIN);
        const dl1 = await request.get(`${UP}/api/files/${file_id}/download`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        expect(dl1.status(), 'download after restore').toBe(200);
        expect(Buffer.from(await dl1.body()).equals(pngBytes), 'file bytes restored exactly').toBe(true);

        // The DB row survived too.
        const token2 = (await page.evaluate(() => sessionStorage.getItem('admin_token'))) || '';
        const tables = await (await request.get(`${UP}/api/admin/tables`, {
            headers: { Authorization: 'Bearer ' + token2 },
        })).json();
        const filesCount = ((tables.find((t: any) => t.name === 'files') || {}).count) || 0;
        expect(filesCount, 'files table row restored').toBeGreaterThan(0);
    });
});
