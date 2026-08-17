import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

// Isolated server (ports 3485/3486).
const PORT = '3485';
const HTTPS_PORT = '3486';
const BASE = `https://127.0.0.1:${HTTPS_PORT}`;
const ADMIN_PW = 'panel-admin';

// All 24 tab buttons that must exist and each must activate its own panel.
const ALL_TABS = [
    'users', 'servers', 'channels', 'messages', 'server-keys', 'server-members',
    'server-bans', 'dm-channels', 'dm-members', 'dm-messages', 'friend-requests',
    'friendships', 'files', 'admin-config', 'pending-events', 'pending-notifications',
    'voice-sessions', 'voice-participants', 'user-media', 'user-key-blobs',
    'profile-data-keys', 'shared-profile-data-keys', 'audit-log', 'raw-tables',
];

async function loginAdminPage(page: Page) {
    await page.goto(`${BASE}/admin.html`);
    await page.waitForSelector('#admin-login-form', { timeout: 10000 });
    await page.fill('#admin-password', ADMIN_PW);
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-panel')).toBeVisible({ timeout: 10000 });
}

test.describe('Admin panel: every tab renders and XSS payloads stay escaped', () => {
    let child: ChildProcess;
    let tmpDb: string;

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `admin-panel-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT, HTTPS_PORT, DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                LOGIN_IP_MAX: '100000', LOGIN_USER_MAX: '100000', REGISTER_IP_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000', HMAC_KEY_IP_MAX: '100000', LOGIN_2FA_IP_MAX: '100000',
                KILL_SWITCH_IP_MAX: '100000', KILL_SWITCH_USER_MAX: '100000',
                ADMIN_LOGIN_IP_MAX: '100000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await request.get(`${BASE}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'isolated server came up').toBe(true);
        const setup = await request.post(`${BASE}/api/admin/login`, { data: { password: ADMIN_PW } });
        expect(setup.ok(), 'admin setup').toBeTruthy();
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
        }
    });

    test('every tab button activates its own panel and loads data without errors', async ({ page }) => {
        test.setTimeout(180000);
        await loginAdminPage(page);

        // All 24 tab buttons exist.
        const tabBtns = page.locator('.tab-btn[data-tab]');
        expect(await tabBtns.count(), '24 tab buttons').toBe(24);
        for (const t of ALL_TABS) {
            await expect(page.locator(`.tab-btn[data-tab="${t}"]`), `tab ${t}`).toHaveCount(1);
        }

        // Register a user + create a server so data tabs have rows.
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const username = `panel_${ts}`;
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'TestPass123!');
        await page.fill('#register-confirm-password', 'TestPass123!');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { name: 'Panel Server', invite_code: 'PNL' + ts.slice(0, 5) },
        });
        expect(srv.ok(), 'server created').toBeTruthy();

        // Back to admin and click through EVERY tab.
        await loginAdminPage(page);
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        for (const t of ALL_TABS) {
            await page.click(`.tab-btn[data-tab="${t}"]`);
            await expect(page.locator(`#tab-${t}`), `panel ${t} active`).toHaveClass(/active/, { timeout: 5000 });
            // Give data a moment to load (lazy endpoints), then confirm no crash.
            await page.waitForTimeout(150);
        }
        expect(errors, 'no page errors while tabbing').toEqual([]);

        // Spot-check a few tabs show real content.
        await page.click('.tab-btn[data-tab="users"]');
        const usersText = await page.locator('#user-list').textContent();
        expect(usersText).toContain(username);

        await page.click('.tab-btn[data-tab="servers"]');
        // Server names are E2E-encrypted, so the admin shows the ciphertext blob;
        // assert a server row exists rather than a plaintext name.
        const serverRows = await page.locator('#server-list tr').count();
        expect(serverRows, 'servers tab has rows').toBeGreaterThan(0);

        // Audit log recorded the admin logins.
        await page.click('.tab-btn[data-tab="audit-log"]');
        const auditText = await page.locator('#audit-log-list').textContent();
        expect(auditText).toContain('admin_login');

        // Raw Tables lists tables and can open a populated one.
        await page.click('.tab-btn[data-tab="raw-tables"]');
        await page.waitForSelector('#raw-tables-list .tab-btn', { timeout: 10000 });
        await page.click('[data-raw-table="users"]');
        await page.waitForSelector('#raw-table-head th', { timeout: 10000 });
        const headText = await page.locator('#raw-table-head').textContent();
        expect(headText).toContain('username');
        expect(await page.locator('#raw-table-body tr').count()).toBeGreaterThan(0);
    });

    test('XSS payloads in usernames and other plaintext fields are escaped everywhere', async ({ page, request }) => {
        test.setTimeout(180000);
        const dialogs: string[] = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
        await loginAdminPage(page);

        // Register a user whose username is a full XSS payload. The server does
        // not restrict username characters, so it lands in the DB verbatim and
        // must be escaped in every admin surface that renders it.
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const payload = '<img src=x onerror="window.__adminXss=1"><script>window.__adminXss2=1</script>';
        const xssUser = payload + ts;

        const reg = await request.post(`${BASE}/api/register`, {
            data: {
                username: xssUser,
                password: 'x'.repeat(64),
                friend_code: 'XSS' + ts.slice(0, 6),
            },
        });
        expect(reg.ok(), 'xss user registered').toBeTruthy();

        // Fresh admin session so the users list reloads.
        await loginAdminPage(page);
        await page.click('.tab-btn[data-tab="users"]');
        await page.waitForSelector('#user-list', { timeout: 10000 });

        // The payload must appear as literal text — never as a live <img>/<script>.
        const usersHtml = await page.locator('#user-list').innerHTML();
        expect(usersHtml).toContain('&lt;img');
        expect(usersHtml).toContain('&lt;script&gt;');
        expect(usersHtml, 'no live img tag in users list').not.toContain('<img');
        expect(await page.evaluate(() => (window as any).__adminXss || 0), 'onerror never fired').toBe(0);
        expect(await page.evaluate(() => (window as any).__adminXss2 || 0), 'script never ran').toBe(0);
        const rendered = await page.locator('#user-list').textContent();
        expect(rendered).toContain(xssUser);

        // Raw Tables browser shows the same escaping.
        await page.click('.tab-btn[data-tab="raw-tables"]');
        await page.waitForSelector('#raw-tables-list .tab-btn', { timeout: 10000 });
        await page.click('[data-raw-table="users"]');
        // Wait for the real rows (the placeholder tr exists before data loads).
        await page.waitForSelector('#raw-table-head th', { timeout: 10000 });
        await page.waitForFunction(() => {
            const body = document.getElementById('raw-table-body');
            return body && body.querySelectorAll('tr').length > 0 &&
                !body.textContent?.includes('No rows.') &&
                !body.textContent?.includes('Pick a table');
        }, { timeout: 10000 });
        const rawHtml = await page.locator('#raw-table-body').innerHTML();
        expect(rawHtml).toContain('&lt;img');
        expect(rawHtml).not.toContain('<img src=x');
        expect(await page.evaluate(() => (window as any).__adminXss || 0), 'still no execution in raw tables').toBe(0);
        expect(await page.evaluate(() => (window as any).__adminXss2 || 0), 'still no script execution').toBe(0);

        // Search/filter surfaces render the escaped text too.
        await page.click('.tab-btn[data-tab="users"]');
        await page.fill('#search-users', xssUser);
        await page.waitForTimeout(300);
        const filtered = await page.locator('#user-list').innerHTML();
        expect(filtered).toContain('&lt;img');
        expect(filtered, 'filtered row still escaped').not.toContain('<img src=x');
        expect(await page.evaluate(() => (window as any).__adminXss || 0), 'search never executes').toBe(0);
    });
});
