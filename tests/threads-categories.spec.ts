import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function registerAndSetup(page: Page, username: string): Promise<{serverId: string, channelId: string}> {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('choice-create-server') !== null, { timeout: 10000 });
    await page.dispatchEvent('#choice-create-server', 'click');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', 'Test Server');
    await page.click('#confirm-create-server');
    await page.waitForTimeout(3000);
    await page.waitForSelector('.server-icon', { timeout: 5000 });
    await page.locator('.server-icon').first().click();
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
        const cl = document.getElementById('channel-list');
        return cl && cl.innerHTML.length > 10;
    }, { timeout: 10000 });
    const createBtn = page.locator('.create-channel-btn').first();
    if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForSelector('#new-channel-name', { timeout: 5000 });
        await page.fill('#new-channel-name', 'general');
        await page.click('#confirm-create-channel');
        await page.waitForTimeout(2000);
    }
    const ch = page.locator('.channel-item').first();
    if (await ch.isVisible().catch(() => false)) {
        await ch.click();
        await page.waitForTimeout(1500);
    }
    await page.waitForFunction(() => {
        const el = document.getElementById('message-input');
        return el && !el.disabled;
    }, { timeout: 10000 });
    return await page.evaluate(() => ({
        serverId: document.querySelector('.server-icon')?.getAttribute('data-id') || '',
        channelId: (document.querySelector('.channel-item.active') || document.querySelector('.channel-item'))?.getAttribute('data-id') || ''
    }));
}

async function sendMessage(page: Page, text: string): Promise<void> {
    await page.locator('#message-input').fill(text);
    await page.click('#send-btn');
    await page.waitForTimeout(2000);
}

test.describe('F3 · Threaded Replies', () => {
    test('thread button opens panel and reply appears', async ({ page }) => {
        const { channelId } = await registerAndSetup(page, unique('f3'));
        await sendMessage(page, 'Parent message');

        // Hover message and click thread button
        const msg = page.locator('.message').first();
        await msg.hover();
        await page.waitForTimeout(500);
        const threadBtn = page.locator('[data-action="thread"]');
        await expect(threadBtn).toBeVisible({ timeout: 5000 });
        await threadBtn.click();
        await page.waitForTimeout(1000);

        // Verify thread panel
        await expect(page.locator('#thread-panel')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#thread-input')).toBeVisible({ timeout: 5000 });

        // Send thread reply
        await page.locator('#thread-input').fill('Thread reply!');
        await page.click('#thread-send-btn');
        await page.waitForTimeout(3000);

        // Verify reply appears
        const count = await page.locator('#thread-messages .thread-message').count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    test('thread panel close button works', async ({ page }) => {
        await registerAndSetup(page, unique('f3c'));
        await sendMessage(page, 'Close test');
        const msg = page.locator('.message').first();
        await msg.hover();
        await page.waitForTimeout(500);
        await page.click('[data-action="thread"]');
        await page.waitForTimeout(1000);
        await expect(page.locator('#thread-panel')).toBeVisible({ timeout: 5000 });
        await page.click('#thread-panel-close-btn');
        await page.waitForTimeout(500);
        const display = await page.evaluate(() => {
            const panel = document.getElementById('thread-panel');
            return panel ? panel.style.display : 'none';
        });
        expect(display).toBe('none');
    });
});

test.describe('F4 · Channel Categories', () => {
    test('create and list categories via API', async ({ page }) => {
        const { serverId } = await registerAndSetup(page, unique('f4'));

        // Create
        const createRes = await page.evaluate(async (sid) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`/api/servers/${sid}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ position: 0 })
            });
            return { status: res.status, body: await res.json() };
        }, serverId);
        expect(createRes.status).toBe(200);
        expect(createRes.body.id).toBeTruthy();

        // List
        const listRes = await page.evaluate(async (sid) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`/api/servers/${sid}/categories`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            return await res.json();
        }, serverId);
        expect(Array.isArray(listRes)).toBe(true);
        expect(listRes.length).toBeGreaterThanOrEqual(1);
    });

    test('non-owner cannot create categories', async ({ page }) => {
        const ownerName = unique('f4o');
        const memberName = unique('f4m');
        await registerAndSetup(page, ownerName);
        const { serverId } = await registerAndSetup(page, ownerName + '2');

        // Get invite code from API
        const inviteCode = await page.evaluate(async (sid) => {
            const token = localStorage.getItem('auth_token');
            const res = await fetch(`/api/servers/${sid}/invite`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            return data.invite_code || data.code || '';
        }, serverId);

        const memberPage = await page.context().newPage();
        await registerAndSetup(memberPage, memberName);

        const result = await memberPage.evaluate(async (args) => {
            const [sid, code] = args;
            const token = localStorage.getItem('auth_token');
            // Join server
            await fetch('/api/invites/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ invite_code: code })
            });
            // Try to create category
            const res = await fetch(`/api/servers/${sid}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ position: 0 })
            });
            return { status: res.status };
        }, [serverId, inviteCode]);
        expect(result.status).toBe(403);
        await memberPage.close();
    });
});
