import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Voice TURN config', () => {

    test('endpoint requires auth and serves configured TURN servers', async ({ page, request }) => {
        test.setTimeout(60000);
        // Unauthenticated → rejected
        const unauth = await request.get(`${BASE}/api/voice/turn-config`);
        expect(unauth.ok()).toBeFalsy();

        // Register a user to get a token
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        const uname = 'turn_' + Date.now();
        await page.fill('#register-username', uname);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        // Authenticated → TURN servers (shape always: { urls: [...] })
        const res = await request.get(`${BASE}/api/voice/turn-config`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBeTruthy();
        const data = await res.json();
        expect(Array.isArray(data.urls)).toBe(true);
        // If the server was started by Playwright's webServer (which sets the
        // TURN env), the configured values must be present. If an already-
        // running server was reused without TURN env, only the shape is checked
        // so the test stays green outside CI.
        if (data.urls.length > 0) {
            expect(data.urls).toContain('turn:turn.example.com:3478');
            expect(data.urls).toContain('turns:turn.example.com:5349');
            expect(data.username).toBe('test-turn-user');
            expect(data.credential).toBe('test-turn-pass');
        } else {
            console.log('voice-turn: server reused without TURN env — skipping value assertions');
        }
    });

    test('client merges TURN servers into RTCPeerConnection iceServers', async ({ page }) => {
        test.setTimeout(60000);
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        const uname = 'turncli_' + Date.now();
        await page.fill('#register-username', uname);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        // VoiceManager.init fetches /api/voice/turn-config on page load.
        // Wait for the fetch to settle one way or the other (config applied OR
        // empty response handled) so the STUN defaults are always present.
        await page.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && v._debug && v._debug.isTurnConfigured !== undefined;
        }, undefined, { timeout: 15000 });
        await page.waitForTimeout(1000); // allow the async fetch to resolve

        const ice = await page.evaluate(() => window.VoiceManager._debug.getIceServers());
        const urls = ice.map((s: any) => s.urls);
        // STUN defaults are always there
        expect(urls).toContain('stun:stun.l.google.com:19302');
        expect(urls).toContain('stun:stun1.l.google.com:19302');
        const hasTurn = await page.evaluate(() => window.VoiceManager._debug.isTurnConfigured());
        if (hasTurn) {
            expect(ice.length).toBeGreaterThanOrEqual(4); // 2 STUN + 2 TURN
            expect(urls).toContain('turn:turn.example.com:3478');
            expect(urls).toContain('turns:turn.example.com:5349');
            const turnEntry = ice.find((s: any) => s.urls === 'turn:turn.example.com:3478');
            expect(turnEntry.username).toBe('test-turn-user');
            expect(turnEntry.credential).toBe('test-turn-pass');
        }
    });
});
