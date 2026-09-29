import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

// The admin-login limiter guards BOTH the first-run admin password setup and
// every later admin login (the check runs before `is_admin_password_set`), so a
// suite that logs in as admin repeatedly from one machine can exhaust it.
//
// `ADMIN_LOGIN_IP_MAX=0` is documented to turn every other limiter off
// (LOGIN_IP_MAX, REAUTH_IP_MAX, FRIEND_REQUEST_IP_MAX, ...), but this one used to
// interpret 0 literally — `count >= 0` is always true, so 0 blocked *every*
// login. These tests pin both halves of the contract on isolated servers:
//   1. 0 disables the limiter outright (a long run of logins all succeed).
//   2. a non-zero budget still throttles (the limit was not removed, only made
//      switchable).

const serverDir = path.join(__dirname, '..', 'server');
const BIN = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');

function api(port: number, method: string, reqPath: string, body?: unknown) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const r = https.request(
            {
                host: 'localhost',
                port,
                method,
                path: reqPath,
                rejectUnauthorized: false,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    : {},
            },
            (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => {
                    let json: any = null;
                    try { json = JSON.parse(d); } catch (_) { /* non-JSON (429 etc.) */ }
                    resolve({ status: res.statusCode || 0, json });
                });
            }
        );
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

async function waitReady(httpPort: number) {
    for (let i = 0; i < 80; i++) {
        try {
            // The plaintext listener answers anything with a 301 — proof it is up.
            const r = await fetch(`http://localhost:${httpPort}/login.html`, { method: 'GET', redirect: 'manual' });
            if (r) return;
        } catch (_) { /* still starting */ }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`isolated server on http ${httpPort} never came up`);
}

async function bootServer(httpPort: number, httpsPort: number, tag: string, extraEnv: Record<string, string>) {
    if (!fs.existsSync(BIN)) throw new Error('server binary not found: ' + BIN);
    const db = path.join(serverDir, `${tag}-${Date.now()}.db`);
    const child: ChildProcess = spawn(BIN, [], {
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(httpPort),
            HTTPS_PORT: String(httpsPort),
            DATABASE_URL: db,
            UPLOAD_DIR: db + '-uploads',
            // Keep every unrelated budget out of the way so the only limiter
            // under test is the admin-login one.
            LOGIN_IP_MAX: '100000',
            LOGIN_USER_MAX: '100000',
            REGISTER_IP_MAX: '100000',
            AUTH_PARAMS_IP_MAX: '100000',
            HMAC_KEY_IP_MAX: '100000',
            FRIEND_REQUEST_IP_MAX: '100000',
            MUTATION_USER_MAX: '100000',
            MUTATION_IP_MAX: '100000',
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    try {
        await waitReady(httpPort);
    } catch (e) {
        child.kill();
        throw new Error(`${String(e)} — stderr: ${stderr.slice(0, 2000)}`);
    }
    const stop = async () => {
        child.kill();
        await new Promise((r) => setTimeout(r, 500));
        for (const p of [db, db + '-wal', db + '-shm']) {
            try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
        }
        try { fs.rmSync(db + '-uploads', { recursive: true, force: true }); } catch (_) { /* none */ }
    };
    return { stop };
}

test.describe('admin-login rate limiter', () => {
    test('ADMIN_LOGIN_IP_MAX=0 turns the admin login limiter off', async () => {
        const { stop } = await bootServer(3470, 3471, 'admin-rl-off', { ADMIN_LOGIN_IP_MAX: '0' });
        try {
            // First call sets the password on the fresh DB; the rest verify it.
            // All of them pass through the limiter, so without the >0 guard
            // call #1 would already be a 429 (and the assertion below would say so).
            for (let i = 1; i <= 15; i++) {
                const res = await api(3471, 'POST', '/api/admin/login', { password: 'admin' });
                expect(res.status, `admin login #${i} must succeed when the limiter is off`).toBe(200);
                expect(res.json?.token, `admin login #${i} returns a token`).toBeTruthy();
            }
        } finally {
            await stop();
        }
    });

    test('a non-zero ADMIN_LOGIN_IP_MAX still throttles', async () => {
        const { stop } = await bootServer(3472, 3473, 'admin-rl-on', {
            ADMIN_LOGIN_IP_MAX: '2',
            ADMIN_LOGIN_IP_WINDOW_SECS: '300',
        });
        try {
            const s1 = await api(3473, 'POST', '/api/admin/login', { password: 'admin' });
            const s2 = await api(3473, 'POST', '/api/admin/login', { password: 'admin' });
            const s3 = await api(3473, 'POST', '/api/admin/login', { password: 'admin' });
            expect(s1.status).toBe(200); // setup
            expect(s2.status).toBe(200); // verify
            expect(s3.status, 'third attempt exceeds the 2-attempt budget').toBe(429);
        } finally {
            await stop();
        }
    });
});
