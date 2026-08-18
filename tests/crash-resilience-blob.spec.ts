import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function login(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
}

test.describe('Crash-resilient blob saves', () => {
    test('server key + invite code survive a crash right after creation', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const username = 'crash_' + ts;

        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const { token } = await registerUser(page1, username);

        // Create a server via the real UI flow
        await page1.click('#add-server-btn');
        await page1.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page1.click('#choice-create-server');
        await page1.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
        await page1.fill('#new-server-name', 'Crash Test Server');
        await page1.click('#confirm-create-server');
        await page1.waitForSelector('#create-server-modal', { state: 'hidden', timeout: 10000 });
        await page1.waitForTimeout(2000); // Let immediate blob save fire

        // Verify server key exists locally
        const hasServerKey = await page1.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_server_') && !k.includes('old') && !k.includes('history')) keys.push(k);
            }
            return keys.length > 0;
        });
        expect(hasServerKey).toBe(true);

        // Verify invite code exists
        const hasInvite = await page1.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_invite_')) keys.push(k);
            }
            return keys.length > 0;
        });
        expect(hasInvite).toBe(true);

        // CRASH: destroy the context (no beforeunload/pagehide fires)
        await ctx1.close();

        // Device 2: login on a fresh browser
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await login(page2, username);

        // Verify server key is restored from blob
        const restoredServerKey = await page2.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_server_') && !k.includes('old') && !k.includes('history')) keys.push(k);
            }
            return keys.length > 0;
        });
        expect(restoredServerKey).toBe(true);

        // Verify invite code is restored
        const restoredInvite = await page2.evaluate(() => {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('e2e_invite_')) keys.push(k);
            }
            return keys.length > 0;
        });
        expect(restoredInvite).toBe(true);

        // Verify identity keys are restored
        const hasIdentity = await page2.evaluate(() => {
            try { return !!E2ECrypto.getIdentityKeyPair(); }
            catch { return false; }
        });
        expect(hasIdentity).toBe(true);

        await ctx2.close();
    });

    test('display-name cache is in blob immediately after a profile fetch', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const username1 = 'crashdn1_' + ts;
        const username2 = 'crashdn2_' + ts;

        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const { token: token1 } = await registerUser(page1, username1);

        // Register second user
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        const { token: token2, user: user2 } = await registerUser(page2, username2);

        // Make them friends
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(fc2).toBeTruthy();
        const fr = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${token2}` },
        })).json();
        expect(incoming.length).toBeGreaterThanOrEqual(1);
        await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        await page1.waitForTimeout(1000);

        // Open DM with user2 — this triggers profile fetch which populates display-name cache
        await page1.evaluate(async (uid) => {
            (document.querySelector(`.dm-item[data-user-id="${uid}"]`) as HTMLElement)?.click?.();
        }, user2.id);
        // Fallback: try clicking DM strip
        await page1.click('.dm-strip-btn').catch(() => {});
        await page1.waitForTimeout(3000); // Let profile fetch + display-name cache save + blob save fire

        // Verify display-name cache has user2's name
        const hasDisplayName = await page1.evaluate((uid) => {
            try {
                const cache = JSON.parse(localStorage.getItem('user_display_name_cache') || '{}');
                return !!cache[uid]?.dn;
            } catch { return false; }
        }, user2.id);
        expect(hasDisplayName).toBe(true);

        // CRASH
        await ctx1.close();

        // Device 3: fresh login as user1
        const ctx3 = await browser.newContext();
        const page3 = await ctx3.newPage();
        await login(page3, username1);

        // Verify display-name cache restored
        const restoredName = await page3.evaluate((uid) => {
            try {
                const cache = JSON.parse(localStorage.getItem('user_display_name_cache') || '{}');
                return cache[uid]?.dn || null;
            } catch { return null; }
        }, user2.id);
        expect(restoredName).toBeTruthy();

        await ctx3.close();
        await ctx2.close();
    });

    test('friend code is in blob immediately after generation', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const username = 'crashfc_' + ts;

        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const { token } = await registerUser(page1, username);

        // Friend code is generated at registration — verify it's in localStorage
        const fc = await page1.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(fc).toBeTruthy();

        // CRASH
        await ctx1.close();

        // Device 2: login and verify friend code restored
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await login(page2, username);

        const restoredFc = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(restoredFc).toBeTruthy();
        expect(restoredFc).toBe(fc);

        await ctx2.close();
    });

    test('identity keys survive crash and restore from blob on new device', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const username = 'crashid_' + ts;

        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        await registerUser(page1, username);

        // Verify identity keys exist
        const hasId = await page1.evaluate(() => {
            try { return !!E2ECrypto.getIdentityKeyPair(); }
            catch { return false; }
        });
        expect(hasId).toBe(true);

        // CRASH
        await ctx1.close();

        // Device 2: fresh login
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await login(page2, username);

        // Verify identity keys restored
        const restoredId = await page2.evaluate(() => {
            try { return !!E2ECrypto.getIdentityKeyPair(); }
            catch { return false; }
        });
        expect(restoredId).toBe(true);

        await ctx2.close();
    });
});
