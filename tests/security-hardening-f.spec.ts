import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

const BASE = 'https://localhost:3443';

// ═══════════════════ Isolated server (F1 / F2 / F5) ═══════════════════
const HTTP_PORT = 3452;
const HTTPS_PORT = 3453;
const HTTP = `http://localhost:${HTTP_PORT}`;
const ALT = `https://localhost:${HTTPS_PORT}`;

let child: ChildProcess;
let tmpDb: string;
let serverReady = false;

function req(opts: http.RequestOptions, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: string }> {
    return new Promise((resolve, reject) => {
        const r = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, data }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

function rawPathGet(port: number, rawPath: string): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        const r = https.request(
            {
                host: 'localhost',
                port,
                method: 'GET',
                path: rawPath, // sent to the server as-is (no client-side normalization)
                rejectUnauthorized: false,
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode || 0, data }));
            }
        );
        r.on('error', reject);
        r.end();
    });
}

// JSON request against the isolated HTTPS server (Node fetch rejects the
// self-signed cert, so every call goes through https.request).
function api(port: number, method: string, path: string, token: string | null, body?: any) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const r = https.request(
            {
                host: 'localhost',
                port,
                method,
                path,
                rejectUnauthorized: false,
                headers: {
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => {
                    let json: any = null;
                    try { json = JSON.parse(d); } catch (_) {}
                    resolve({ status: res.statusCode || 0, json });
                });
            }
        );
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

async function adminLogin(password: string) {
    let { status, json } = await api(HTTPS_PORT, 'POST', '/api/admin/login', null, { password });
    if (status !== 200 || !json || !json.token) {
        // Fresh-DB first call SETS the password; second call verifies.
        ({ status, json } = await api(HTTPS_PORT, 'POST', '/api/admin/login', null, { password }));
    }
    expect(status).toBe(200);
    expect(json.token).toBeTruthy();
    return json.token as string;
}

test.describe('F-series security hardening', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async () => {
        const serverDir = path.join(__dirname, '..', 'server');
        let bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) {
            bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        }
        if (!fs.existsSync(bin)) throw new Error('server binary not found');
        tmpDb = path.join(serverDir, `f-test-${Date.now()}.db`);
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT: String(HTTP_PORT),
                HTTPS_PORT: String(HTTPS_PORT),
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                // F2: tight per-IP registration budget so the limiter test can
                // exhaust it quickly from one IP.
                REGISTER_IP_MAX: '3',
                LOGIN_IP_MAX: '100000',
                LOGIN_USER_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000',
                HMAC_KEY_IP_MAX: '100000',
                ADMIN_LOGIN_IP_MAX: '100000',
                FRIEND_REQUEST_IP_MAX: '100000',
                MUTATION_USER_MAX: '100000',
                MUTATION_IP_MAX: '100000',
                FILE_STORAGE_QUOTA_BYTES: '100000000000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderrBuf = '';
        if (child.stderr) child.stderr.on('data', (d) => { stderrBuf += d; });
        // Liveness probe goes over plain HTTP (the F1 redirect port): Node's
        // global fetch rejects the self-signed TLS cert, and the HTTP listener
        // answers any request with a 301 — which proves the server is up.
        for (let i = 0; i < 80; i++) {
            try {
                const r = await fetch(`${HTTP}/login.html`, { method: 'GET', redirect: 'manual' });
                if (r) { serverReady = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 300));
        }
        expect(serverReady, 'isolated server came up. stderr: ' + stderrBuf.slice(0, 2000)).toBe(true);
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) { try { fs.unlinkSync(tmpDb); } catch (_) {} }
            if (tmpDb) { try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {} }
    });

    test('F1: plain-HTTP listener only redirects to HTTPS (no plaintext app)', async () => {
        const res = await fetch(`${HTTP}/login.html`, { method: 'GET', redirect: 'manual' });
        expect(res.status).toBe(301);
        const loc = res.headers.get('location') || '';
        expect(loc).toContain(`https://localhost:${HTTPS_PORT}`);
        expect(loc).toContain('/login.html');
        // And a bare root request also redirects.
        const root = await fetch(`${HTTP}/`, { method: 'GET', redirect: 'manual' });
        expect(root.status).toBe(301);
        expect(root.headers.get('location') || '').toContain(`:${HTTPS_PORT}/`);
        // The HTTPS listener still serves the app (not a redirect loop).
        // (Node's global fetch rejects the self-signed cert, so use https.request.)
        // The isolated DB is fresh, so non-admin paths 302 to the admin setup
        // page — /admin.html itself is served directly.
        const app = await req({ host: 'localhost', port: HTTPS_PORT, path: '/admin.html', rejectUnauthorized: false });
        expect(app.status).toBe(200);
        const body = (await req({ host: 'localhost', port: HTTPS_PORT, path: '/login.html', rejectUnauthorized: false })).status;
        expect(body).toBe(302);
    });

    test('F2: registration is rate-limited per IP', async () => {
        const reg = async (i: number) => {
            const r = await api(HTTPS_PORT, 'POST', '/api/register', null, {
                username: `f2user_${i}_${Date.now()}`,
                password: 'x'.repeat(64),
            });
            return r.status;
        };
        const s1 = await reg(1);
        const s2 = await reg(2);
        const s3 = await reg(3);
        expect(s1).toBe(201);
        expect(s2).toBe(201);
        expect(s3).toBe(201);
        const s4 = await reg(4);
        expect(s4).toBe(429);
    });

    test('F5: admin audit IP redaction toggle (off by default, live-appliable)', async () => {
        // Default: off.
        let token = await adminLogin('fredact');
        const before = await api(HTTPS_PORT, 'GET', '/api/admin/runtime-config', token);
        expect(before.status).toBe(200);
        expect(before.json.admin_audit_redact_ips).toBe(false);

        // A normal admin action logs the raw IP (127.0.0.1 via the isolated listener).
        await api(HTTPS_PORT, 'POST', '/api/admin/logout', token);
        // Logout revokes the token — re-login for a fresh one before reading.
        token = await adminLogin('fredact');
        let log = await api(HTTPS_PORT, 'GET', '/api/admin/audit-log', token);
        expect(log.status).toBe(200);
        expect(Array.isArray(log.json) && log.json.length > 1).toBe(true);
        // Newest first: [0] is this re-login, [1] is the logout we just did.
        expect(log.json[1].action).toBe('admin_logout');
        expect(log.json[1].ip).not.toBe('*.*.*.*');
        expect(log.json[1].ip).toBeTruthy();

        // Enable redaction live, then log another action.
        const setRes = await api(HTTPS_PORT, 'PUT', '/api/admin/runtime-config', token, { admin_audit_redact_ips: true });
        expect(setRes.status).toBe(200);
        await api(HTTPS_PORT, 'POST', '/api/admin/logout', token);
        token = await adminLogin('fredact');
        log = await api(HTTPS_PORT, 'GET', '/api/admin/audit-log', token);
        expect(log.json[1].action).toBe('admin_logout');
        expect(log.json[1].ip).toBe('*.*.*.*');
    });
});

test.describe('F-series hardening (main server)', () => {

    test('F6: WS upgrade is rejected for a cross-site Origin, allowed for same-origin', async () => {
        // Manual WS handshake. A 101 shows up as an "upgrade" event (not a
        // regular response) on Node's https client; a rejected handshake is a
        // normal response (403).
        const handshake = (origin: string) =>
            new Promise<number>((resolve, reject) => {
                const r = https.request(
                    {
                        host: 'localhost',
                        port: 3443,
                        method: 'GET',
                        path: '/ws',
                        rejectUnauthorized: false,
                        headers: {
                            Host: 'localhost:3443',
                            Origin: origin,
                            Upgrade: 'websocket',
                            Connection: 'Upgrade',
                            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                            'Sec-WebSocket-Version': '13',
                        },
                    },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode || 0);
                    }
                );
                r.on('upgrade', (_res, socket) => {
                    socket.destroy();
                    resolve(101);
                });
                r.on('error', reject);
                r.end();
            });
        const evil = await handshake('https://evil.example.com');
        expect(evil).toBe(403);
        const good = await handshake('https://localhost:3443');
        expect(good).toBe(101);
        // A missing Origin (native client) is allowed through — as long as the
        // handshake itself is otherwise complete.
        const noOrigin = await new Promise<number>((resolve, reject) => {
            const r = https.request(
                {
                    host: 'localhost',
                    port: 3443,
                    method: 'GET',
                    path: '/ws',
                    rejectUnauthorized: false,
                    headers: {
                        Host: 'localhost:3443',
                        Upgrade: 'websocket',
                        Connection: 'Upgrade',
                        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                        'Sec-WebSocket-Version': '13',
                    },
                },
                (res) => { res.resume(); resolve(res.statusCode || 0); }
            );
            r.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
            r.on('error', reject);
            r.end();
        });
        expect(noOrigin).toBe(101);
    });

    test('F8: CSP + security headers on both static pages and API responses', async () => {
        const pageRes = await req({ host: 'localhost', port: 3443, path: '/', rejectUnauthorized: false });
        const cspPage = pageRes.headers['content-security-policy'] || '';
        expect(cspPage).toContain("object-src 'none'");
        expect(cspPage).toContain("frame-src 'none'");
        expect(cspPage).toContain("frame-ancestors 'none'");
        expect(pageRes.headers['x-content-type-options']).toBe('nosniff');
        expect(pageRes.headers['x-frame-options']).toBe('DENY');
        expect(pageRes.headers['strict-transport-security']).toBeTruthy();

        // API (non-static) responses get the same CSP via the middleware.
        const apiRes = await req({ host: 'localhost', port: 3443, path: '/api/nonexistent-route', rejectUnauthorized: false });
        expect(apiRes.status).toBe(404);
        const cspApi = apiRes.headers['content-security-policy'] || '';
        expect(cspApi).toContain("object-src 'none'");
        expect(cspApi).toContain("frame-src 'none'");
    });

    test('F9: path traversal is blocked (static handler + API)', async () => {
        const attempts = [
            '/../../etc/passwd',
            '/../server/.env',
            '/..%2f..%2fetc%2fpasswd',
            '/static/../server/.env',
            '/api/../../../etc/passwd',
        ];
        for (const p of attempts) {
            const r = await rawPathGet(3443, p);
            expect(r.status, `traversal attempt ${p} must not succeed`).toBe(404);
            expect(r.data.toLowerCase()).not.toContain('jwt_secret');
        }
    });

    test('F3: CDN scripts carry SRI integrity attributes', async () => {
        const r = await req({ host: 'localhost', port: 3443, path: '/index.html', rejectUnauthorized: false });
        const html = r.data;
        const jsqr = html.match(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/jsqr@[^"]*"[^>]*>/);
        expect(jsqr).toBeTruthy();
        expect(jsqr![0]).toContain('integrity="sha384-');
        expect(jsqr![0]).toContain('crossorigin="anonymous"');
        const qrgen = html.match(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcode-generator@[^"]*"[^>]*>/);
        expect(qrgen).toBeTruthy();
        expect(qrgen![0]).toContain('integrity="sha384-');
    });

    test('F3: message content is escaped — no XSS from user text (DM)', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'fxss1_' + ts;
        const user2 = 'fxss2_' + ts;
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();

        const reg = async (pg: any, uname: string) => {
            await pg.goto(`${BASE}/login.html`);
            await pg.waitForSelector('#show-register');
            await pg.click('#show-register');
            await pg.fill('#register-username', uname);
            await pg.fill('#register-password', 'password123');
            await pg.fill('#register-confirm-password', 'password123');
            await pg.click('#register-form button[type="submit"]');
            await pg.waitForURL('**/index.html', { timeout: 15000 });
            return pg.evaluate(() => ({ token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || '{}') }));
        };
        const b2 = await reg(page2, user2);
        const b1 = await reg(page, user1);

        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${b1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${b2.token}` },
        })).json();
        await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${b2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });

        const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
            headers: { Authorization: `Bearer ${b1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${b1.token}` },
        })).json();

        // A opens the DM and sends an XSS payload as plain text.
        await page.waitForTimeout(800);
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1500);
        await page.evaluate(({ dmId }) => {
            const item = document.querySelector(`.dm-item[data-dm-id="${dmId}"]`);
            if (item) (item as HTMLElement).click();
        }, { dmId: dm.id });
        await page.waitForSelector('#message-input:not([disabled])', { timeout: 15000 });
        const payload = '<img src=x onerror="window.__xss1=1"><script>window.__xss2=1</script><b onclick="window.__xss3=1">boldish</b>';
        await page.fill('#message-input', payload);
        await page.click('#send-btn');
        await page.waitForTimeout(1500);

        // B opens the same DM and inspects the rendered message.
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(1500);
        await page2.evaluate(({ dmId }) => {
            const item = document.querySelector(`.dm-item[data-dm-id="${dmId}"]`);
            if (item) (item as HTMLElement).click();
        }, { dmId: dm.id });
        await page2.waitForSelector('.message .text', { timeout: 15000 });

        const bState = await page2.evaluate(() => ({
            xss1: (window as any).__xss1,
            xss2: (window as any).__xss2,
            xss3: (window as any).__xss3,
            textHasLiteralImg: document.querySelector('.message .text')?.textContent?.includes('<img src=x') || false,
            realImgInText: !!document.querySelector('.message .text img'),
            realBInText: !!document.querySelector('.message .text b'),
        }));
        expect(bState.xss1).toBeUndefined();
        expect(bState.xss2).toBeUndefined();
        expect(bState.xss3).toBeUndefined();
        expect(bState.textHasLiteralImg).toBe(true);
        expect(bState.realImgInText).toBe(false);
        expect(bState.realBInText).toBe(false);
    });
});
