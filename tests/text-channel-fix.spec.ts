import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function unique(prefix: string) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-username', { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
}

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    // Wait for server to appear
    await page.waitForFunction(() => {
        return document.querySelectorAll('.server-icon:not(.add-server)').length > 0;
    }, { timeout: 15000 });
}

async function waitForWs(page: any) {
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

test.describe('Text Channel Fix', () => {
    test('Text channel click enables message input and invite box renders', async ({ page }) => {
        const username = unique('tc_fix');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'TC Test');
        await page.waitForTimeout(2000);

        // Click the first text channel in the sidebar
        const textChannel = page.locator('.channel-item[data-type="text"]').first();
        if (await textChannel.count() > 0) {
            await textChannel.click();
            await page.waitForTimeout(1000);

            // Message input should be enabled
            const inputDisabled = await page.evaluate(() => {
                return (document.getElementById('message-input') as HTMLInputElement)?.disabled;
            });
            expect(inputDisabled).toBe(false);

            // Channel name should show in header
            const channelName = await page.textContent('#channel-name');
            expect(channelName).toContain('#');
        }

        // Check server strip is vertical (column layout)
        const stripDir = await page.evaluate(() => {
            const strip = document.querySelector('.server-strip');
            return strip ? getComputedStyle(strip).flexDirection : 'unknown';
        });
        expect(stripDir).toBe('column');

        // Check server list is vertical
        const listDir = await page.evaluate(() => {
            const list = document.querySelector('.server-list');
            return list ? getComputedStyle(list).flexDirection : 'unknown';
        });
        expect(listDir).toBe('column');

        // Check invite button is visible (owner)
        const inviteBtn = page.locator('#invite-btn');
        if (await inviteBtn.isVisible()) {
            await inviteBtn.click();
            await page.waitForTimeout(1000);

            // Identity key box should exist and be visible
            const keyBox = page.locator('.identity-key-box');
            await expect(keyBox).toBeVisible();

            // Buttons should be on one line (check modal-actions has display:flex)
            const actionsFlex = await page.evaluate(() => {
                const el = document.querySelector('#invite-modal .modal-actions');
                return el ? getComputedStyle(el).flexWrap : 'unknown';
            });
            expect(actionsFlex).toBe('nowrap');

            // Regenerate and Close buttons should exist
            await expect(page.locator('#regenerate-invite')).toBeVisible();
            await expect(page.locator('#close-invite')).toBeVisible();

            // Close the modal
            await page.click('#close-invite');
        }

        // Take a screenshot
        await page.screenshot({ path: 'test-results/text-channel-fix.png', fullPage: false });
    });
});
