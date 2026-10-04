import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

/**
 * The client address used to be read straight out of `X-Forwarded-For`, which
 * is a claim made by whoever opened the TCP connection. Two attacks fell out of
 * that, and both are about a client pretending to be somewhere it is not:
 *
 *   1. bucket minting — a fresh `X-Forwarded-For` per request produced a fresh
 *      rate-limit bucket, so NO per-IP limit could ever trip (login, register,
 *      friend requests, admin login, WS auth … all of them);
 *   2. bucket burning — pointing the header at a victim's address spent *their*
 *      budget, so the victim got 429s while the attacker never did.
 *
 * `client_ip_mw` now resolves the address from the socket peer, consulting the
 * header only when that peer is a trusted proxy. Two isolated servers prove
 * both halves of the policy:
 *
 *   - TRUSTED_PROXIES="" (trust nobody) → the header is ignored, every spoofed
 *     address shares the peer's one bucket, and the limit trips;
 *   - the default policy (loopback is a proxy) → the same headers DO produce
 *     distinct buckets, so a real reverse proxy keeps working unchanged.
 */

const UNTRUSTED = 'https://localhost:3465'; // TRUSTED_PROXIES=""  → header ignored
const TRUSTED = 'https://localhost:3467';   // default policy       → loopback trusted

const LOGIN_MAX = 3;

let childUntrusted: ChildProcess | null = null;
let childTrusted: ChildProcess | null = null;
const tmpDbs: string[] = [];

function httpsProbe(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const req = https.get(url, { rejectUnauthorized: false }, (res) => {
            res.resume();
            resolve(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
}

function httpsPostJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = https.request(url, {
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers,
            },
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: out }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.write(data);
        req.end();
    });
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
        const req = https.request(url, {
            method: 'GET',
            rejectUnauthorized: false,
            headers,
        }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: out }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.end();
    });
}

async function spawnServer(
    tag: string,
    port: number,
    httpsPort: number,
    extraEnv: Record<string, string>,
): Promise<ChildProcess> {
    const serverDir = path.join(__dirname, '..', 'server');
    const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
    if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
    const tmpDb = path.join(serverDir, `iptrust-${tag}-${Date.now()}.db`);
    tmpDbs.push(tmpDb);
    const child = spawn(bin, [], {
        cwd: serverDir,
        env: {
            ...process.env,
            PORT: String(port),
            HTTPS_PORT: String(httpsPort),
            DATABASE_URL: tmpDb,
            UPLOAD_DIR: tmpDb + '-uploads',
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `https://localhost:${httpsPort}`;
    let up = false;
    for (let i = 0; i < 60; i++) {
        if (await httpsProbe(base + '/')) { up = true; break; }
        await new Promise((r) => setTimeout(r, 300));
    }
    expect(up, `isolated server ${tag} came up`).toBe(true);
    return child;
}

/** Everything except the limiter under test is raised out of the way. */
const QUIET_LIMITS = {
    REGISTER_IP_MAX: '100000',
    LOGIN_IP_MAX: '100000',
    LOGIN_USER_MAX: '100000',
    AUTH_PARAMS_IP_MAX: '100000',
    HMAC_KEY_IP_MAX: '100000',
    CLIENT_CONFIG_IP_MAX: '100000',
    ADMIN_LOGIN_IP_MAX: String(LOGIN_MAX),
    ADMIN_LOGIN_IP_WINDOW_SECS: '300',
};

test.describe('client IP trust policy — isolated servers', () => {
    test.beforeAll(async () => {
        childUntrusted = await spawnServer('untrusted', 3464, 3465, {
            ...QUIET_LIMITS,
            // Set-but-empty: trust NO peer, so the header is never consulted.
            TRUSTED_PROXIES: '',
        });
        childTrusted = await spawnServer('trusted', 3466, 3467, {
            ...QUIET_LIMITS,
            // Unset → the default allow-list (loopback only).
        });
    });

    test.afterAll(async () => {
        for (const c of [childUntrusted, childTrusted]) {
            if (c) c.kill();
        }
        await new Promise((r) => setTimeout(r, 500));
        for (const db of tmpDbs) {
            for (const f of [db, db + '-wal', db + '-shm', db + '-uploads']) {
                try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) {}
            }
        }
    });

    test('a spoofed X-Forwarded-For cannot mint a fresh bucket (peer not a trusted proxy)', async () => {
        test.setTimeout(60000);

        // The first login performs first-time setup on the fresh DB and hands
        // back a token; it also counts as attempt #1 in the peer's bucket.
        const setup = await httpsPostJson(`${UNTRUSTED}/api/admin/login`, { password: 'iptrust-admin' });
        expect(setup.status).toBe(200);
        const token = JSON.parse(setup.body).token;
        expect(token).toBeTruthy();

        // Eight attempts, each claiming a DIFFERENT source address. If the
        // header were trusted these would be eight separate buckets and the
        // limit (3) could never be reached — which is exactly the hole.
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) {
            const res = await httpsPostJson(
                `${UNTRUSTED}/api/admin/login`,
                { password: 'definitely-not-the-password-' + i },
                { 'X-Forwarded-For': `203.0.113.${10 + i}` },
            );
            statuses.push(res.status);
        }

        // The setup login above already spent one attempt in this bucket, so
        // at most LOGIN_MAX - 1 of the loop's attempts fit. The point is that
        // the budget is reached AT ALL — with the header trusted, each of
        // these would be its own bucket and 429 would never appear.
        const first429 = statuses.indexOf(429);
        expect(first429, `the limit must trip even though every attempt claimed a new address: ${statuses}`)
            .toBeGreaterThanOrEqual(0);
        expect(first429, `it must trip within the budget: ${statuses}`).toBeLessThanOrEqual(LOGIN_MAX - 1);
        expect(statuses.slice(first429).every((s) => s === 429),
            `once the bucket is spent it stays spent: ${statuses}`).toBe(true);

        // Nothing in the audit log may carry a raw address, spoofed or not.
        const audit = await httpsGet(`${UNTRUSTED}/api/admin/audit-log?limit=50`, {
            Authorization: `Bearer ${token}`,
        });
        expect(audit.status).toBe(200);
        const rows = JSON.parse(audit.body);
        expect(Array.isArray(rows) && rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(String(row.ip), `audit ip ${row.ip} must be a pseudonym, not an address`)
                .toMatch(/^(\*+\.\*+\.\*+\.\*+|h1_[0-9a-f]{32})$/);
        }
    });

    test('a trusted proxy still passes the real client through — the header keeps working', async () => {
        test.setTimeout(60000);

        const setup = await httpsPostJson(`${TRUSTED}/api/admin/login`, { password: 'iptrust-admin' });
        expect(setup.status).toBe(200);
        expect(JSON.parse(setup.body).token).toBeTruthy();

        // Same eight spoofed headers, but now the peer (loopback) IS our proxy,
        // so each address is a legitimate separate bucket. This is the property
        // every existing X-Forwarded-For based test depends on.
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) {
            const res = await httpsPostJson(
                `${TRUSTED}/api/admin/login`,
                { password: 'definitely-not-the-password-' + i },
                { 'X-Forwarded-For': `198.51.100.${20 + i}` },
            );
            statuses.push(res.status);
        }
        expect(statuses.filter((s) => s === 429),
            `each distinct address must get its own budget: ${statuses}`).toEqual([]);
        expect(statuses.every((s) => s === 401 || s === 200),
            `wrong passwords answer 401, never 429: ${statuses}`).toBe(true);
    });
});
