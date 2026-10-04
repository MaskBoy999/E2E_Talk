// Regression tests for the 2026-10 security review fixes. Each describes the
// hole, not just the new behaviour, so a future "cleanup" that reopens it fails
// here with the reason attached.
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { apiLogin, loginBody } from './_auth-helpers';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const HOST = 'localhost';
const PORT = 3443;

/** Raw HTTPS request so we can forge a Host header (fetch forbids it). */
function rawHttps(opts: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                host: '127.0.0.1',
                port: PORT,
                rejectUnauthorized: false,
                method: opts.method || 'GET',
                path: opts.path,
                headers: opts.headers,
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
            },
        );
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function registerUser(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `sec_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 30000 });
}

test.describe('finding 12 — header/standards deltas', () => {
    test('API responses carry the new hardening headers, without HSTS preload', async ({ request }) => {
        const res = await request.get(`${BASE}/api/client-config`);
        expect(res.status()).toBeLessThan(500);
        const h = res.headers();

        const pp = h['permissions-policy'] || '';
        expect(pp, 'Permissions-Policy must be present').toBeTruthy();
        expect(pp).toContain('camera=(self)');
        expect(pp).toContain('microphone=(self)');
        expect(pp, 'geolocation must be denied outright').toContain('geolocation=()');

        expect(h['cross-origin-opener-policy']).toBe('same-origin');
        expect(h['cross-origin-resource-policy']).toBe('same-origin');
        expect(h['x-robots-tag']).toContain('noindex');
        expect(h['cache-control']).toBe('no-store');

        const hsts = h['strict-transport-security'] || '';
        expect(hsts).toContain('max-age=31536000');
        // The preload token is meaningless for a self-hosted hostname (and an
        // opt-in list must not receive a name nobody submitted).
        expect(hsts).not.toContain('preload');
    });

    test('logout tells the browser to evict cookies, cache and storage', async ({ request }) => {
        const res = await request.post(`${BASE}/api/logout`);
        expect(res.status()).toBeLessThan(500);
        const csd = res.headers()['clear-site-data'] || '';
        expect(csd).toContain('"storage"');
        expect(csd).toContain('"cookies"');
        expect(csd).toContain('"cache"');
    });

    test('the login page\'s stale-cookie housekeeping does NOT wipe origin storage', async ({ request }) => {
        // The login page posts to /api/logout on every load to evict a stale
        // HttpOnly cookie (static/auth.js). If that call carried
        // `Clear-Site-Data: "storage"`, the browser would delete the very
        // preferences the page's own wipe deliberately preserves (session
        // duration, media caches) — and a real sign-out would be
        // indistinguishable from merely opening the login page.
        const res = await request.post(`${BASE}/api/logout?cookie_only=1`);
        expect(res.status()).toBeLessThan(500);
        const csd = res.headers()['clear-site-data'] || '';
        expect(csd, 'housekeeping must not delete origin storage').not.toContain('"storage"');
        // The cookie eviction itself must still happen.
        const setCookie = res.headers()['set-cookie'] || '';
        expect(setCookie).toContain('__Host-e2e_token=;');
        // And the real sign-out stays destructive.
        const real = await request.post(`${BASE}/api/logout`);
        expect(real.headers()['clear-site-data'] || '').toContain('"storage"');
    });
});

test.describe('finding 6 — DNS rebinding / cross-site requests', () => {
    test('an unknown Host header is rejected (421)', async () => {
        const res = await rawHttps({
            path: '/api/client-config',
            headers: { Host: 'evil.example.com' },
        });
        expect(res.status, 'a Host this server does not own must not be served').toBe(421);
    });

    test('the real Host is still served', async () => {
        const res = await rawHttps({ path: '/api/client-config', headers: { Host: `localhost:${PORT}` } });
        expect(res.status).toBe(200);
    });

    test('a null Origin is rejected on state-changing endpoints', async ({ request }) => {
        const res = await request.post(`${BASE}/api/login`, {
            headers: { Origin: 'null', 'Content-Type': 'application/json' },
            data: { username: 'nobody', password: 'nope' },
        });
        expect(res.status(), 'sandboxed/data: callers are never this app').toBe(403);
    });

    test('Fetch Metadata cross-site is rejected even without Origin', async ({ request }) => {
        const res = await request.post(`${BASE}/api/login`, {
            headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
            data: { username: 'nobody', password: 'nope' },
        });
        expect(res.status()).toBe(403);
    });

    test('normal same-origin login attempts are unaffected (401, not 403)', async ({ request }) => {
        const res = await request.post(`${BASE}/api/login`, {
            headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
            data: { username: 'nobody', password: 'nope' },
        });
        expect(res.status()).toBe(401);
    });

    test('WebSocket handshake with null Origin is refused', async () => {
        const key = Buffer.from('0123456789abcdef').toString('base64');
        const res = await rawHttps({
            path: '/ws',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                Origin: 'null',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
            },
        });
        expect(res.status, 'the frame must never be authorised from a null origin').toBe(403);
    });
});

test.describe('finding 4 — the published HMAC key is derived, not the master', () => {
    test('hmac-key returns the derived key, and never the configured master', async ({ request }) => {
        const res = await request.get(`${BASE}/api/hmac-key`);
        expect(res.ok()).toBeTruthy();
        const { hmac_key: published } = await res.json();
        expect(published, 'a key must be published for client pseudonyms').toBeTruthy();
        // The derived key is a hex SHA-256 output; the configured master is the
        // 64-char base62 the server generates. If the master were still served,
        // it would not look like this.
        expect(published).toMatch(/^[0-9a-f]{64}$/);

        // Hard proof when the dev .env is present: the served value must differ
        // from the master it is derived from.
        const envPath = path.join(__dirname, '..', 'server', '.env');
        if (fs.existsSync(envPath)) {
            const env = fs.readFileSync(envPath, 'utf8');
            const m = /^\s*HMAC_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(env);
            if (m) {
                expect(published, 'the master must never leave the server').not.toBe(m[1]);
            }
        }
    });
});

test.describe('finding 7 — WebSocket frame limit', () => {
    test('an oversized frame closes the socket instead of being processed', async ({ page }) => {
        await registerUser(page);
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        const result = await page.evaluate(async (token) => {
            return await new Promise<{ closed: boolean; hugeSent: boolean }>((resolve) => {
                const ws = new WebSocket(`wss://${location.host}/ws`);
                const out = { closed: false, hugeSent: false };
                ws.onopen = () => {
                    try {
                        // 2 MiB in one message; the server caps messages at 1 MiB.
                        ws.send(JSON.stringify({ type: 'auth', token: token, padding: 'x'.repeat(2 * 1024 * 1024) }));
                        out.hugeSent = true;
                    } catch (_) { /* send may itself fail when the limit is client-side */ }
                };
                ws.onclose = () => { out.closed = true; resolve(out); };
                ws.onerror = () => {};
                setTimeout(() => resolve(out), 10000);
            });
        }, token);

        expect(result.closed, 'the socket must be closed, not left half-open').toBe(true);
    });
});

test.describe('finding 8 — document previews are sandboxed', () => {
    test('a .docx renders in an opaque-origin sandbox that the app cannot reach', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        const docxBase64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.docx')).toString('base64');

        await page.evaluate(async (b64) => {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const blob = new Blob([bin], {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            await (window as any).DocPreview.previewDocument(blob, 'tiny.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        }, docxBase64);

        const frame = page.locator('iframe.docx-sandbox');
        await frame.waitFor({ state: 'attached', timeout: 20000 });

        const sandbox = await frame.getAttribute('sandbox');
        expect(sandbox).toContain('allow-scripts');
        expect(sandbox, 'allow-same-origin would put the frame back in the app origin').not.toContain('allow-same-origin');

        // Cross-origin means the app (and any injected doc script) cannot read
        // the app's DOM, and vice versa.
        const isolated = await page.evaluate(() => {
            const f = document.querySelector('iframe.docx-sandbox') as HTMLIFrameElement;
            return f ? f.contentDocument === null : false;
        });
        expect(isolated, 'the frame document must be unreachable from the app origin').toBe(true);

        // The proof that it actually rendered: the parent only learns a height
        // from the frame's own postMessage after docx-preview finished.
        await expect.poll(async () => await frame.evaluate((f) => (f as HTMLElement).style.height), {
            timeout: 30000,
            message: 'the sandbox never reported a rendered height',
        }).toMatch(/px$/);
    });

    test('an .xlsx renders in the same sandbox, and its table never enters the app DOM', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        await page.evaluate(async () => {
            const s = document.createElement('script');
            s.src = '/libs/xlsx.full.min.js';
            document.head.appendChild(s);
            await new Promise((r) => { s.onload = r; setTimeout(r, 3000); });
            const XLSX = (window as any).XLSX;
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Age'], ['Alice', 30]]), 'People');
            const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            await (window as any).DocPreview.previewDocument(blob, 'grades.xlsx',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        });

        const frame = page.locator('iframe.xlsx-sandbox');
        await frame.waitFor({ state: 'attached', timeout: 20000 });

        const sandbox = await frame.getAttribute('sandbox');
        expect(sandbox).toContain('allow-scripts');
        expect(sandbox, 'allow-same-origin would put the frame back in the app origin').not.toContain('allow-same-origin');

        const isolated = await page.evaluate(() => {
            const f = document.querySelector('iframe.xlsx-sandbox') as HTMLIFrameElement;
            return f ? f.contentDocument === null : false;
        });
        expect(isolated, 'the frame document must be unreachable from the app origin').toBe(true);

        // The sink the review flagged: SheetJS builds the table inside the
        // frame, so the app origin's DOM must never contain it.
        await expect.poll(async () => await frame.getAttribute('data-rendered'), {
            timeout: 30000,
            message: 'the sandbox never reported a rendered sheet',
        }).toBe('People');
        expect(await page.locator('#doc-preview-content table').count(),
            'the spreadsheet table must not be injected into the app DOM').toBe(0);

        // And the proof that it really rendered, in there.
        await expect(page.frameLocator('iframe.xlsx-sandbox').locator('td', { hasText: 'Alice' })).toHaveCount(1);
    });
});

test.describe('finding 3 — nonce-signed logins (no replayable credential)', () => {
    const PASSWORD = 'testpass1234';

    async function registerFresh(page: Page, password = PASSWORD): Promise<string> {
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const username = `f3_${ts}`;
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 60000 });
        return username;
    }

    // The pre-fix credential exactly as old clients transmitted it:
    // HMAC-SHA256(hash_key, password). An attacker still captures this, and the
    // login endpoint now ignores the field entirely.
    async function legacyCredential(page: Page, username: string, password: string): Promise<string> {
        return page.evaluate(async ({ username, password }) => {
            const p = await (await fetch('/api/auth-params/' + encodeURIComponent(username))).json();
            const hk = E2ECrypto.decryptWithPassword(p.encrypted_hash_key, password, p.hash_key_salt, p.hash_key_nonce);
            return E2ECrypto.hmacHex(new Uint8Array(E2ECrypto.base64ToArrayBuffer(hk)), password);
        }, { username, password });
    }

    test('a captured login cannot be replayed; the legacy credential is refused', async ({ page }) => {
        const username = await registerFresh(page);

        // The account now carries a login public key, and auth-params hands out
        // a single-use nonce instead of relying on a replayable credential.
        const params = await page.evaluate(async (u) => {
            return await (await fetch('/api/auth-params/' + encodeURIComponent(u))).json();
        }, username);
        expect(params.login_public_key, 'a supported client registers its login public key').toBeTruthy();
        expect(params.login_nonce).toMatch(/^[0-9a-f]{64}$/);

        // Build one valid signed request and replay it byte-for-byte.
        const signed = await loginBody(page, username, PASSWORD);
        expect(signed.login_signature, 'the request carries a signature, not a credential').toBeTruthy();
        expect(signed.password, 'no reusable credential is sent at all').toBeUndefined();
        const first = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: signed,
        });
        expect(first.status()).toBe(200);
        const replay = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: signed,
        });
        expect(replay.status(), 'the nonce is single-use, so the replay must fail').toBe(401);

        // The old replayable credential — captured from any pre-fix login or
        // from the registration-era value — is dead for this account.
        const legacy = await legacyCredential(page, username, PASSWORD);
        const legacyLogin = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username, password: legacy },
        });
        expect(legacyLogin.status(), 'the captured legacy credential must be refused').toBe(401);
    });

    test('multi-device one-account is unchanged: a second device logs in with only the password', async ({ page, browser }) => {
        const username = await registerFresh(page);

        // Device A: fresh UI login (clears the registration session first).
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', PASSWORD);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 30000 });

        // Device B: a separate storage context (no shared local state), same
        // username + password — the schema stays one account, many devices.
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.fill('#login-username', username);
        await page2.fill('#login-password', PASSWORD);
        await page2.click('#login-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 30000 });

        // Both devices derive the same login public key from (hash_key,
        // password): nothing is device-bound and no per-device enrollment step
        // exists. Both sessions are live at once.
        const pkA = await page.evaluate(async (u) => (await (await fetch('/api/auth-params/' + encodeURIComponent(u))).json()).login_public_key, username);
        const pkB = await page2.evaluate(async (u) => (await (await fetch('/api/auth-params/' + encodeURIComponent(u))).json()).login_public_key, username);
        expect(pkA).toBeTruthy();
        expect(pkB).toBe(pkA);
        const tokenB = await page2.evaluate(() => localStorage.getItem('token'));
        const meB = await page2.request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${tokenB}` } });
        expect(meB.status()).toBe(200);
        await ctx.close();
    });

    test('there is no credential path left: registration demands a login key, and a keyless account could never log in', async ({ page }) => {
        // A pre-fix client's register request (no `login_public_key`) is refused
        // outright: an account without a signing key could never log in, so the
        // server no longer creates one.
        await page.route('**/api/register', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const body = JSON.parse(route.request().postData() || '{}');
            delete body.login_public_key;
            await route.continue({ postData: JSON.stringify(body) });
        });
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const username = `f3keyless_${ts}`;
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        await expect(page.locator('#error-message')).toBeVisible({ timeout: 30000 });
        await page.unroute('**/api/register');

        // Nothing was created, and a body in the old credential shape is just
        // ignored — there is no signature and no credential field to fall back to.
        const params = await page.request.get(`${BASE}/api/auth-params/${username}`);
        expect(params.status(), 'the keyless registration must not create an account').toBe(404);
        const attempt = await page.request.post(`${BASE}/api/login`, {
            headers: { 'Content-Type': 'application/json' },
            data: { username, password: 'a'.repeat(64), login_public_key: 'a'.repeat(44) },
        });
        expect(attempt.status(), 'there is no credential/upgrade login path').toBe(401);
    });

    test('the session cookie is __Host- prefixed, and obviously weak passwords are refused client-side', async ({ page }) => {
        const username = await registerFresh(page);
        const res = await apiLogin(page, username, PASSWORD);
        expect(res.status()).toBe(200);
        const setCookie = String(res.headers()['set-cookie'] || '');
        expect(setCookie).toContain('__Host-e2e_token=');
        expect(setCookie).toContain('Secure');
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('Path=/');
        expect(setCookie, 'the __Host- prefix forbids a Domain attribute').not.toContain('Domain=');

        // Client-side strength floor: one character class, repeated → refused
        // before anything is sent (the server can never see the raw password).
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', 'f3weak_' + Date.now().toString(36));
        await page.fill('#register-password', 'aaaaaaaa');
        await page.fill('#register-confirm-password', 'aaaaaaaa');
        await page.click('#register-form button[type="submit"]');
        await expect(page.locator('#error-message')).toContainText('too weak');
        expect(await page.locator('#register-form').isVisible()).toBe(true);
    });
});

test.describe('web connection tab — a cached app can point at a new server', () => {
    test('plain browser shows Settings → Connection with the address and a working change flow', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        // No Tauri globals in a browser context; the tab must still exist.
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
        const tab = page.locator('#connection-settings-tab');
        await expect(tab).toBeVisible();
        await tab.click();

        const shown = await page.locator('#connection-server-address').textContent();
        expect(shown).toBe(new URL(BASE).origin);

        // The app routes dialogs through ui-dialog.js, which auto-answers from
        // window.__uiDialogQueue under automation and records what it showed
        // in window.__uiDialogLog. No native dialog handler is involved.
        async function answerPrompt(next: string): Promise<{ origin: string; alerts: string[] }> {
            await page.evaluate((answer) => {
                (window as any).__uiDialogLog = [];
                (window as any).__uiDialogQueue = { confirm: [], prompt: [answer] };
            }, next);
            await page.click('#connection-change-server-btn');
            await page.waitForTimeout(400);
            const alerts = await page.evaluate(() =>
                ((window as any).__uiDialogLog || []).filter((e: any) => e.type === 'alert').map((e: any) => e.message));
            return { origin: new URL(page.url()).origin, alerts };
        }

        // Replying with the current origin is a no-op.
        const same = await answerPrompt(new URL(BASE).origin);
        expect(same.origin).toBe(new URL(BASE).origin);
        expect(same.alerts.length).toBe(0);

        // An http:// address is refused with an explanation, no navigation.
        const refused = await answerPrompt('http://100.64.0.9:3443');
        expect(refused.alerts.join('|')).toContain('https');
        expect(refused.origin).toBe(new URL(BASE).origin);
    });
});

// ---------------------------------------------------------------------------
// The raw password is the client-side root of every key (message encryption,
// the hash_key unwrap, identity escrow, the vault): SECURITY_REVIEW_FIXES.md
// §6.3 records that constraint and rules out server-side login schemes that
// would need the password itself. These tests pin the traffic + storage half
// of it, so a future "simplification" of loginRequestBody can't quietly put
// the raw password on the wire or on disk. There is no exception: the legacy
// login fallbacks (raw password, keyless-account credential + upgrade,
// pre-hash verifiers) were removed outright — the app is pre-release and all
// accounts are test accounts — so no server response may talk the client into
// sending the client-side root.
test.describe('raw-password client-side root', () => {
    /** Every plausible encoding of the raw password on the wire or in SQLite. */
    function rawPasswordForms(pw: string): string[] {
        return [pw, Buffer.from(pw, 'utf8').toString('base64'), encodeURIComponent(pw)];
    }

    test('register + every login path keep it out of request bodies and off the server disk', async ({ page }) => {
        test.setTimeout(180000);
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const username = `rawpw_${ts}`;
        // Unique, four character classes, no JSON-escapable characters, so a
        // raw occurrence in a request body is unambiguous.
        const PASSWORD = `Rp9-${ts}-${Math.random().toString(36).slice(2, 10)}!Aa`;

        type Post = { path: string; body: string };
        const posts: Post[] = [];
        page.on('request', (req) => {
            let p: string;
            try { p = new URL(req.url()).pathname; } catch { return; }
            if (req.method() === 'POST' && (p === '/api/register' || p === '/api/login')) {
                posts.push({ path: p, body: req.postData() || '' });
            }
        });
        const loginPosts = () => posts.filter((p) => p.path === '/api/login');

        // 1) Register through the real UI.
        await page.goto(`${BASE}/login.html`);
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', PASSWORD);
        await page.fill('#register-confirm-password', PASSWORD);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 60000 });
        expect(posts.filter((p) => p.path === '/api/register').length,
            'the register POST must be captured (otherwise the check is vacuous)').toBeGreaterThanOrEqual(1);

        // The new account is on the modern signed-login protocol and is not
        // flagged as pre-hash, so the client's raw-password gate must be off.
        const params = await page.evaluate(async (u) => {
            return await (await fetch('/api/auth-params/' + encodeURIComponent(u))).json();
        }, username);
        expect(params.login_public_key, 'a current client registers a login key').toBeTruthy();
        expect(params.legacy_raw_password, 'the legacy flag is gone with the legacy paths').toBeUndefined();
        expect(JSON.stringify(params), 'auth-params never echoes the raw password').not.toContain(PASSWORD);

        // 2) Correct login (the signed path).
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', PASSWORD);
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 60000 });
        expect(loginPosts().some((p) => p.body.includes('login_signature')),
            'the correct login must carry a nonce signature, so the negative below is meaningful').toBe(true);

        // 3) Wrong password — a common typo. This used to fall through to the
        //    raw-password fallback; a rejected login must still not transmit it.
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', `${PASSWORD}-wrong`);
        await page.click('#login-form button[type="submit"]');
        await expect(page.locator('#error-message')).toBeVisible({ timeout: 30000 });

        // 4) Unknown username — no account exists to be flagged pre-hash.
        await page.fill('#login-username', `rawpw_ghost_${ts}`);
        await page.fill('#login-password', PASSWORD);
        await page.click('#login-form button[type="submit"]');
        await expect(page.locator('#error-message')).toBeVisible({ timeout: 30000 });

        // 5) /api/auth-params unavailable — the outage that used to fall back
        //    to the raw password even for a correct one.
        await page.route('**/api/auth-params/**', (route) =>
            route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
        await page.fill('#login-username', username);
        await page.fill('#login-password', PASSWORD);
        await page.click('#login-form button[type="submit"]');
        await expect(page.locator('#error-message')).toBeVisible({ timeout: 30000 });
        await page.unroute('**/api/auth-params/**');

        expect(loginPosts().length, 'all four login attempts must be captured').toBeGreaterThanOrEqual(4);

        // The regression itself: no form of the raw password in any POST body.
        for (const post of posts) {
            for (const form of rawPasswordForms(PASSWORD)) {
                expect(post.body.includes(form),
                    `the raw password left the client in POST ${post.path}: ${post.body.slice(0, 400)}`).toBe(false);
            }
        }

        // Server storage: the SQLite files the running test server writes. The
        // username showing up in them proves the scan is looking at live data
        // (WAL commits land immediately; the row can surface a moment later).
        const serverDir = path.join(__dirname, '..', 'server');
        const usernameBytes = Buffer.from(username, 'utf8');
        await expect.poll(() => {
            const db = path.join(serverDir, 'e2e_chat.db');
            const wal = path.join(serverDir, 'e2e_chat.db-wal');
            return (fs.existsSync(db) && fs.readFileSync(db).includes(usernameBytes))
                || (fs.existsSync(wal) && fs.readFileSync(wal).includes(usernameBytes));
        }, {
            timeout: 15000,
            intervals: [250, 500, 1000, 2000],
            message: 'the account row never appeared in e2e_chat.db* — is DATABASE_URL pointing at another file?',
        }).toBe(true);

        const dbFiles = fs.readdirSync(serverDir).filter((n) => n.startsWith('e2e_chat.db')).sort();
        expect(dbFiles.length, 'server/e2e_chat.db must exist next to the server').toBeGreaterThan(0);
        const blobs = dbFiles.map((n) => ({ name: n, buf: fs.readFileSync(path.join(serverDir, n)) }));
        expect(blobs.some((b) => b.buf.includes(usernameBytes)), 'the scan must cover the live account row').toBe(true);
        for (const blob of blobs) {
            for (const form of rawPasswordForms(PASSWORD)) {
                for (const enc of ['utf8', 'utf16le'] as const) {
                    expect(blob.buf.includes(Buffer.from(form, enc)),
                        `the raw password was stored in server/${blob.name} (${enc})`).toBe(false);
                }
            }
        }
    });

    test('there is no raw-password path at all, even if a server asks for one', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });

        // A stale or hostile auth-params response can claim anything. The
        // retired `legacy_raw_password` shape from the previous design is the
        // worst case: the client must not answer it with the raw password.
        const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');
        await page.route('**/api/auth-params/**', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    encrypted_hash_key: b64(32),
                    hash_key_salt: b64(16),
                    hash_key_nonce: b64(24),
                    has_kill_switch: false,
                    legacy_raw_password: true, // ignored: nothing may opt back in
                    login_public_key: null,
                    login_nonce: null,
                }),
            }));

        const raw = `Legacy-Raw9-${Date.now().toString(36)}!`;
        // Wrong password: decryption fails, and the body carries no secret.
        const wrong = await page.evaluate((pw) => (window as any).E2ECrypto.loginRequestBody('someone', pw), raw);
        expect(wrong.password, 'there is no password field to put it in').toBeUndefined();
        expect(JSON.stringify(wrong)).not.toContain(raw);

        // No hash key at all (the dead pre-hash shape): same.
        await page.unroute('**/api/auth-params/**');
        await page.route('**/api/auth-params/**', (route) =>
            route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"User not found"}' }));
        const missing = await page.evaluate((pw) => (window as any).E2ECrypto.loginRequestBody('someone', pw), raw);
        expect(missing.password).toBeUndefined();
        expect(JSON.stringify(missing)).not.toContain(raw);
        await page.unroute('**/api/auth-params/**');
    });
});
