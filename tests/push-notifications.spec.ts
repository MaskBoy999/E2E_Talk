import { test, expect, type Page } from '@playwright/test';

/**
 * Push notification plumbing (plan §A3.5 / Phase 3).
 *
 * The server owns the whole pipeline for *closed-app* notifications:
 *  - it self-generates a VAPID keypair and serves the public half,
 *  - clients register Web Push subscriptions (endpoint + ECDH keys) or FCM
 *    tokens against their account,
 *  - dead subscriptions (404/410 from the push service) are pruned on send.
 *
 * Only the client-visible API is asserted here — actually delivering a push
 * needs a browser push service (or a Firebase project), which the harness has
 * no access to.
 */

// Overridable so the suite can also be pointed at an isolated instance
// (HTTPS_PORT=3444 with its own DATABASE_URL) without disturbing a dev server.
const BASE = process.env.BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string): Promise<string> {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
    const token = await page.evaluate(() => {
        const w = window as any;
        return w._secGet ? w._secGet('token') : localStorage.getItem('token');
    });
    expect(token, 'registration should yield a session token').toBeTruthy();
    return token as string;
}

/** POST with the session token, evaluated in-page so TLS stays consistent. */
async function api(page: Page, path: string, token: string | null, body?: unknown) {
    return page.evaluate(
        async ({ path, token, body }) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(path, {
                method: 'POST',
                headers,
                body: JSON.stringify(body ?? {}),
            });
            let json: any = null;
            try { json = await res.json(); } catch (_) {}
            return { status: res.status, json };
        },
        { path, token, body }
    );
}

test.describe('push notifications', () => {
    test.setTimeout(180000);

    test('index.html loads the push client exactly once', async ({ page }) => {
        // Guards the class of bug where a script tag points at a missing or
        // duplicated file (the page still renders, but push silently dies).
        const res = await page.request.get(`${BASE}/push-client.js`);
        expect(res.status(), '/push-client.js should be served').toBe(200);
        const html = await (await page.request.get(`${BASE}/index.html`)).text();
        expect(html.match(/push-client\.js/g) || []).toHaveLength(1);
        // No auto-updater by decision (plan §A3.10) — its client script is gone.
        expect(html).not.toContain('box-updater.js');
    });

    test('serves a VAPID public key for pushManager.subscribe', async ({ page }) => {
        const res = await page.request.get(`${BASE}/api/push/vapid-public-key`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body.publicKey).toBe('string');
        // Uncompressed P-256 point (65 bytes) base64url-encoded — no padding.
        expect(body.publicKey.length).toBeGreaterThan(80);
        expect(body.publicKey).not.toMatch(/[+/=]/);
    });

    test('registration requires auth, a valid platform and web ECDH keys', async ({ page }) => {
        await register(page, unique('push_auth'));

        // No bearer token → 401.
        const anon = await api(page, '/api/push/register', null, {
            platform: 'web', token: 'https://push.example/abc', p256dh: 'x', auth: 'y',
        });
        expect(anon.status).toBe(401);

        const token = await page.evaluate(() => {
            const w = window as any;
            return w._secGet ? w._secGet('token') : localStorage.getItem('token');
        });

        // Unknown platform → 400.
        const bad = await api(page, '/api/push/register', token as string, {
            platform: 'ios', token: 'whatever',
        });
        expect(bad.status).toBe(400);

        // Web push without the ECDH keys the server needs to encrypt → 400.
        const noKeys = await api(page, '/api/push/register', token as string, {
            platform: 'web', token: 'https://push.example/abc',
        });
        expect(noKeys.status).toBe(400);
    });

    test('registers, upserts and unregisters a web push subscription', async ({ page }) => {
        const token = await register(page, unique('push_web'));
        const endpoint = `https://push.example.test/${unique('sub')}`;

        const first = await api(page, '/api/push/register', token, {
            platform: 'web',
            token: endpoint,
            p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc1ySZEQZWY6E9g5iUs7W3JZd7nZ2Qe1w',
            auth: 'BTtbYn5V5tWYhRmMWUqP2Q',
        });
        expect(first.status).toBe(200);

        // Same endpoint again (the client re-registers on every boot) → upsert, not an error.
        const again = await api(page, '/api/push/register', token, {
            platform: 'web',
            token: endpoint,
            p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc1ySZEQZWY6E9g5iUs7W3JZd7nZ2Qe1w',
            auth: 'BTtbYn5V5tWYhRmMWUqP2Q',
        });
        expect(again.status).toBe(200);

        const gone = await api(page, '/api/push/unregister', token, { token: endpoint });
        expect(gone.status).toBe(200);
    });

    test('accepts an FCM token for the Android box', async ({ page }) => {
        const token = await register(page, unique('push_fcm'));
        const res = await api(page, '/api/push/register', token, {
            platform: 'android',
            token: `fcm_${unique('tok')}`,
        });
        expect(res.status).toBe(200);
    });
});
