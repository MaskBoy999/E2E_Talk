import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function uniqueUsername(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
    // Wait for loading overlay to disappear
    await page.evaluate(() => {
        const el = document.getElementById('loading-overlay');
        if (el) el.remove();
    });
    await page.waitForTimeout(500);
}

async function waitForWs(page: any) {
    await page.waitForFunction(() => {
        return (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN;
    }, { timeout: 10000 });
}

test.describe('Sidebar Fix: Migrations Registered', () => {

    test('Sidebar renders servers, identity key box, and DM list after fresh login', async ({ page }) => {
        const username = uniqueUsername('sidebar');
        await registerUser(page, username);

        // Check sidebar elements exist
        const elements = await page.evaluate(() => {
            return {
                serverStrip: !!document.querySelector('.server-strip'),
                serverList: !!document.querySelector('.server-list'),
                friendCode: !!document.querySelector('.identity-key-box'),
                dmList: !!document.querySelector('.dm-list'),
                messageInput: !!document.getElementById('message-input'),
                currentUser: document.getElementById('current-user')?.textContent || '',
            };
        });

        expect(elements.serverStrip).toBe(true);
        expect(elements.serverList).toBe(true);
        expect(elements.friendCode).toBe(true);
        expect(elements.dmList).toBe(true);
        expect(elements.messageInput).toBe(true);
        expect(elements.currentUser).toContain(username);
    });

    test('Can create a server and it appears in sidebar', async ({ page }) => {
        const username = uniqueUsername('createsrv');
        await registerUser(page, username);
        await waitForWs(page);

        // Click add server button to open choice modal
        await page.waitForSelector('#add-server-btn', { timeout: 10000 });
        await page.click('#add-server-btn');
        await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await page.click('#choice-create-server');
        await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });

        const serverName = 'TestServer ' + Date.now();
        await page.fill('#new-server-name', serverName);
        await page.click('#confirm-create-server');

        // Wait for server to appear in sidebar
        await page.waitForFunction(() => {
            const icons = document.querySelectorAll('.server-icon');
            return icons.length > 0;
        }, { timeout: 15000 });

        const serverCount = await page.evaluate(() => document.querySelectorAll('.server-icon').length);
        expect(serverCount).toBeGreaterThan(0);
    });

    test('No 500 errors on page load (servers, blocks, DMs)', async ({ page }) => {
        const username = uniqueUsername('no500');
        const failedRequests: string[] = [];
        page.on('response', (r) => {
            if (r.status() >= 500) failedRequests.push(r.url() + ' -> ' + r.status());
        });

        await registerUser(page, username);
        await page.waitForTimeout(3000);

        expect(failedRequests.length).toBe(0);
    });

    test('Block user system initializes without errors', async ({ page }) => {
        const username = uniqueUsername('blockui');
        await registerUser(page, username);
        await waitForWs(page);

        // Verify the blockedUsers cache exists
        const hasBlockedUsers = await page.evaluate(() => {
            return Array.isArray((window as any).blockedUsers);
        });
        expect(hasBlockedUsers).toBe(true);

        // Verify the block system loads without errors
        const blockedCount = await page.evaluate(() => {
            return ((window as any).blockedUsers || []).length;
        });
        expect(blockedCount).toBe(0);
    });

    test('No JS errors on chat page load', async ({ page }) => {
        const jsErrors: string[] = [];
        page.on('pageerror', (e) => jsErrors.push(e.message));

        const username = uniqueUsername('nojserr');
        await registerUser(page, username);
        await page.waitForTimeout(3000);

        // Filter out known non-critical errors (CDN SSL, notification permission, etc.)
        const criticalErrors = jsErrors.filter(e =>
            !e.includes('SSL') &&
            !e.includes('notification') &&
            !e.includes('favicon')
        );
        expect(criticalErrors).toEqual([]);
    });
});
