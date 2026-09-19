import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Multi-device sessions + live local-state sync.
 *
 * These tests exist because of one concrete, reproducible failure: signing in
 * on a SECOND device signed the FIRST one out. The root cause was an empty
 * device id — a fresh browser had no `e2e_device_key` yet, `getWsDeviceId()`
 * returned undefined, the server stored the session under the empty string and
 * then deleted every other session that shared it (i.e. every other device).
 *
 * The same empty id also silenced cross-device sync: `blob_updated` /
 * `groups_changed` were announced with an id nothing ever wrote, so every
 * receiver believed the message was its own echo and skipped the pull.
 */

const BASE = 'https://localhost:3443';
const PASSWORD = 'password12345';
const unique = (b: string) => `${b}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Record every WS message a page receives, so we can prove a kick did/didn't happen. */
async function tapWs(page: Page) {
    await page.addInitScript(() => {
        (window as any).__wsMsgs = [];
        const Orig = window.WebSocket;
        // @ts-ignore — constructible shim that records inbound frames
        window.WebSocket = function (...args: any[]) {
            const ws = new (Orig as any)(...args);
            ws.addEventListener('message', (e: MessageEvent) => {
                try { (window as any).__wsMsgs.push(String(e.data)); } catch (_) {}
            });
            return ws;
        };
        (window as any).WebSocket.prototype = (Orig as any).prototype;
        (window as any).WebSocket.OPEN = (Orig as any).OPEN;
    });
}

async function register(page: Page, username: string): Promise<string> {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    return await page.evaluate(() => localStorage.getItem('token') || '');
}

async function login(page: Page, username: string): Promise<string> {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-form', { state: 'visible', timeout: 20000 });
    await page.fill('#login-username', username);
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    return await page.evaluate(() => localStorage.getItem('token') || '');
}

async function waitForWs(page: Page, ms = 15000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
        const open = await page.evaluate(() => typeof (window as any).ws !== 'undefined'
            && (window as any).ws && (window as any).ws.readyState === 1);
        if (open) return true;
        await page.waitForTimeout(200);
    }
    return false;
}

/** Raw authenticated request from inside a page (so it uses that device's session). */
async function api(page: Page, path: string, init: { method?: string; body?: unknown } = {}) {
    return await page.evaluate(async ([p, i]) => {
        const res = await fetch(p as string, {
            method: (i as any).method || 'GET',
            headers: {
                'Authorization': 'Bearer ' + localStorage.getItem('token'),
                'Content-Type': 'application/json',
            },
            body: (i as any).body ? JSON.stringify((i as any).body) : undefined,
        });
        let json: any = null;
        try { json = await res.json(); } catch (_) {}
        return { status: res.status, body: json };
    }, [path, init] as const);
}

test.describe('Multi-device sessions', () => {
    test('signing in on a second device does not sign the first one out', async ({ browser }) => {
        test.setTimeout(180000);
        const username = unique('md2');

        const ctxA: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageA = await ctxA.newPage();
        await tapWs(pageA);
        await register(pageA, username);
        await waitForWs(pageA);

        // The device key must exist BEFORE the first request, otherwise the
        // server files the session under '' and every browser looks the same.
        const devA = await pageA.evaluate(() => ({
            raw: !!localStorage.getItem('e2e_device_key'),
            wsId: (window as any).getWsDeviceId(),
        }));
        expect(devA.raw, 'this browser has a device key').toBe(true);
        expect(devA.wsId && devA.wsId.length, 'and a non-empty network device id').toBeGreaterThan(8);

        // Second, completely fresh browser profile signs into the same account.
        const ctxB: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        await tapWs(pageB);
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForSelector('#login-form', { state: 'visible' });
        const devBBefore = await pageB.evaluate(() => {
            // On the login page, BEFORE any request is made.
            return (typeof (window as any).getWsDeviceId === 'function') ? (window as any).getWsDeviceId() : null;
        });
        expect(devBBefore, 'a fresh browser identifies itself before signing in').toBeTruthy();
        await login(pageB, username);
        await waitForWs(pageB);

        const devB = await pageB.evaluate(() => (window as any).getWsDeviceId());
        expect(devB).not.toBe(devA.wsId);

        // Give the server (and both sockets) time to react to the second login.
        await pageA.waitForTimeout(3500);

        // (1) The first device is still on the app, not bounced to login.
        expect(new URL(pageA.url()).pathname).toContain('index.html');
        // (2) It was never told its session was revoked.
        const revoked = await pageA.evaluate(() =>
            ((window as any).__wsMsgs || []).filter((m: string) => m.indexOf('session_revoked') !== -1));
        expect(revoked, 'the first device is never told it was signed out').toEqual([]);
        // (3) Its token still works against the API.
        const servers = await api(pageA, '/api/servers');
        expect(servers.status, 'the first device can still call the API').toBe(200);
        // (4) The server lists TWO distinct sessions, both with a device id.
        const sessions = await api(pageA, '/api/auth/sessions');
        expect(sessions.status).toBe(200);
        const list = (sessions.body && (sessions.body.sessions || sessions.body)) as any[];
        expect(Array.isArray(list), 'sessions endpoint returns a list').toBe(true);
        const live = list.filter((s: any) => !s.revoked);
        expect(live.length, 'both devices hold a live session').toBeGreaterThanOrEqual(2);
        for (const s of live) {
            expect(s.device_id, 'every live session names its device').toBeTruthy();
        }

        await ctxA.close();
        await ctxB.close();
    });

    test('two devices of one account keep separate, non-empty device ids', async ({ browser }) => {
        test.setTimeout(180000);
        const username = unique('mdids');

        const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageA = await ctxA.newPage();
        await register(pageA, username);
        await waitForWs(pageA);
        const idA = await pageA.evaluate(() => (window as any).getWsDeviceId());

        const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageB = await ctxB.newPage();
        await login(pageB, username);
        await waitForWs(pageB);
        const idB = await pageB.evaluate(() => (window as any).getWsDeviceId());

        expect(idA).toBeTruthy();
        expect(idB).toBeTruthy();
        expect(idA).not.toBe(idB);

        // Reloading a device must not change its identity (same session row).
        await pageA.reload();
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
        const idAAfter = await pageA.evaluate(() => (window as any).getWsDeviceId());
        expect(idAAfter).toBe(idA);

        await ctxA.close();
        await ctxB.close();
    });
});

test.describe('Shared local state (key blob)', () => {
    test('the blob carries the shared app state, not just encryption keys', async ({ browser }) => {
        test.setTimeout(120000);
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await register(page, unique('blobkeys'));
        await waitForWs(page);

        const probe = await page.evaluate(() => {
            const uid = JSON.parse(localStorage.getItem('user') || '{}').id || 'anon';
            localStorage.setItem('e2e_server_groups_' + uid, JSON.stringify([{ id: 'g1', name: 'Work' }]));
            localStorage.setItem('muted_servers', JSON.stringify(['s1']));
            localStorage.setItem('sb_muted', JSON.stringify(['u1']));
            const bundle = (window as any).E2ECrypto.buildKeyBundle();
            return {
                groups: (window as any).E2ECrypto.isBundleKey('e2e_server_groups_' + uid),
                versions: (window as any).E2ECrypto.isBundleKey('voice_sb_volume_u1'),
                muted: (window as any).E2ECrypto.isBundleKey('muted_servers'),
                sbMuted: (window as any).E2ECrypto.isBundleKey('sb_muted'),
                token: (window as any).E2ECrypto.isBundleKey('token'),
                inBundle: typeof bundle['e2e_server_groups_' + uid] === 'string',
                bundleMuted: bundle['muted_servers'],
                bundleVer: bundle.v,
            };
        });
        expect(probe.groups, 'server folders belong to the blob').toBe(true);
        expect(probe.versions, 'per-user volumes belong to the blob').toBe(true);
        expect(probe.muted, 'mutes belong to the blob').toBe(true);
        expect(probe.sbMuted, 'soundboard mutes belong to the blob').toBe(true);
        expect(probe.token, 'the auth token never belongs to the blob').toBe(false);
        expect(probe.inBundle).toBe(true);
        expect(probe.bundleMuted).toBe(JSON.stringify(['s1']));
        expect(probe.bundleVer).toBeGreaterThanOrEqual(4);

        await ctx.close();
    });

    test('a local change is pushed to the server blob by itself', async ({ browser }) => {
        test.setTimeout(120000);
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await register(page, unique('blobpush'));
        await waitForWs(page);

        // No app code asked for a save here: writing shared state must be enough
        // for the mirror to push it (and the server to announce it).
        // (`sb_muted` — the per-user soundboard mute list — is written by the app
        // only on an explicit toggle, so nothing re-renders it away mid-test.)
        await page.evaluate(() => {
            localStorage.setItem('sb_muted', JSON.stringify(['mirror_probe']));
        });

        const pw = await page.evaluate(() => {
            const encPw = localStorage.getItem('e2e_encrypted_password');
            const dk = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_device_key')));
            const b64 = (window as any).E2ECrypto.decodeEncryptedFileKey(encPw, dk);
            return b64 ? atob(b64) : null;
        });
        expect(pw).toBeTruthy();

        await expect.poll(async () => {
            const res = await api(page, '/api/key-blob');
            if (res.status !== 200 || !res.body || !res.body.encrypted_blob) return 'no-blob';
            const got = await page.evaluate(([blob, salt, nonce, pass]) => {
                const bundle = (window as any).E2ECrypto.decryptKeyBundle(blob, pass, salt, nonce);
                return bundle ? String(bundle['sb_muted']) : 'undecryptable';
            }, [res.body.encrypted_blob, res.body.salt, res.body.nonce, pw] as const);
            return got;
        }, { message: 'the server blob contains the new local state', timeout: 20000 })
            .toBe(JSON.stringify(['mirror_probe']));

        await ctx.close();
    });

    test('a stale write is rejected with the current blob, and merging keeps both sides', async ({ browser }) => {
        test.setTimeout(120000);
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await register(page, unique('blobrace'));
        await waitForWs(page);

        const result = await page.evaluate(async () => {
            const t = localStorage.getItem('token');
            const E = (window as any).E2ECrypto;
            const pw = (function () {
                const encPw = localStorage.getItem('e2e_encrypted_password');
                const dk = new Uint8Array(E.base64ToArrayBuffer(localStorage.getItem('e2e_device_key')));
                const b64 = E.decodeEncryptedFileKey(encPw, dk);
                return b64 ? atob(b64) : null;
            })();
            const put = async (extra: Record<string, unknown>, baseRev: number | null) => {
                const bundle = E.buildKeyBundle();
                Object.assign(bundle, extra);
                const enc = E.encryptKeyBundle(bundle, pw);
                const res = await fetch('/api/key-blob', {
                    method: 'PUT',
                    headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        encrypted_blob: enc.encrypted_private_key, salt: enc.salt, nonce: enc.nonce,
                        device_id: (window as any).getWsDeviceId(), base_rev: baseRev,
                    }),
                });
                return { status: res.status, body: await res.json() };
            };

            const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
            // Device 1 writes on whatever revision exists now.
            const first = await put({ ['e2e_server_groups_' + uid]: JSON.stringify([{ id: 'first' }]) }, null);
            const revAfterFirst = first.body.rev;
            // Device 2 (simulated) writes on the SAME base revision.
            localStorage.setItem('e2e_server_groups_' + uid, JSON.stringify([{ id: 'second' }]));
            const second = await put({ ['e2e_server_groups_' + uid]: JSON.stringify([{ id: 'second' }]) }, revAfterFirst);
            // Now a device holding the ORIGINAL revision tries to write: stale.
            const stale = await put({ ['e2e_server_groups_' + uid]: JSON.stringify([{ id: 'stale' }]) }, revAfterFirst);
            return {
                firstStatus: first.status,
                secondStatus: second.status,
                staleStatus: stale.status,
                staleBody: stale.body,
                revAfterFirst,
            };
        });

        expect(result.firstStatus).toBe(200);
        expect(result.secondStatus).toBe(200);
        // The stale write is refused and handed the winner's blob to merge.
        expect(result.staleStatus, 'a write based on an old revision is refused').toBe(409);
        expect(result.staleBody && result.staleBody.encrypted_blob, 'and returns the current blob').toBeTruthy();
        expect(result.staleBody.rev, 'with its revision').toBeGreaterThan(result.revAfterFirst);

        await ctx.close();
    });
});
