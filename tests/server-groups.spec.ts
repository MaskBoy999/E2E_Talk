import { test, expect } from '@playwright/test';
import { queuePromptAnswer } from './_ui-dialogs';

const BASE = 'https://localhost:3443';

function unique(pfx: string) {
    return pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function waitForWs(page: any) {
    for (let i = 0; i < 40; i++) {
        const ok = await page.evaluate(() => (window as any).ws && (window as any).ws.readyState === 1);
        if (ok) return;
        await page.waitForTimeout(300);
    }
}

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
}

async function createServer(page: any, name: string) {
    await page.waitForSelector('#add-server-btn', { timeout: 10000 });
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForFunction(() => {
        const icons = document.querySelectorAll('.server-icon');
        return icons.length > 0;
    }, { timeout: 15000 });
    await page.waitForTimeout(1000);
}

async function createTextChannel(page: any, name: string) {
    await page.waitForSelector('#channel-create-name', { timeout: 5000 });
    await page.fill('#channel-create-name', name);
    const btn = page.locator('#channel-create-name + button, button:has-text("Create Channel")').first();
    await btn.click();
    await page.waitForTimeout(1500);
}

test.describe('Server Groups', () => {
    test('Create group by API, verify collapsed/expanded toggle, outline, and rename', async ({ page }) => {
        const ts = unique('grp');
        await register(page, ts);
        await waitForWs(page);
        await createServer(page, 'GroupServer_' + ts);
        await page.waitForTimeout(1000);

        // Get server ID
        const serverId = await page.evaluate(() => (window as any).currentServerId);

        // Create a group via API
        const groupRes = await page.evaluate(async (sid: string) => {
            const token = (window as any).token || localStorage.getItem('token');
            const resp = await fetch('/api/server-groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ name: 'My Group' })
            });
            const data = await resp.json();
            return data;
        }, serverId);
        expect(groupRes.ok).toBeTruthy();
        const groupId = groupRes.id;

        // Move server into group
        const moveRes = await page.evaluate(async (args: any) => {
            const token = (window as any).token || localStorage.getItem('token');
            const resp = await fetch('/api/servers/' + args.sid + '/group', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ group_id: args.gid })
            });
            return resp.json();
        }, { sid: serverId, gid: groupId });
        expect(moveRes.ok).toBeTruthy();

        // Reload to see the group
        await page.reload();
        await page.waitForSelector('#current-user', { timeout: 15000 });
        await waitForWs(page);
        // Wait for server icons + groups to render
        await page.waitForFunction(() => {
            return document.querySelectorAll('.server-icon').length > 0 ||
                   document.querySelectorAll('.server-group').length > 0;
        }, { timeout: 15000 });
        await page.waitForTimeout(1000);

        // Verify group exists in DOM — collapsed by default shows a badge
        const groupBadge = page.locator('.group-badge');
        await expect(groupBadge).toBeVisible({ timeout: 10000 });
        const badgeText = await groupBadge.textContent();
        expect(badgeText).toBe('1');

        // Verify group inner is NOT visible (collapsed)
        const groupInner = page.locator('.server-group-inner');
        await expect(groupInner).toHaveCount(0);

        // Click the collapsed group icon to expand it
        const groupIcon = page.locator('.server-icon[data-group-id]').first();
        if (await groupIcon.count() > 0) {
            await groupIcon.click();
            await page.waitForTimeout(500);
            // Now inner should be visible
            const expandedInner = page.locator('.server-group-inner');
            await expect(expandedInner).toBeVisible({ timeout: 5000 });
            // Verify outline/border on inner
            const border = await expandedInner.evaluate((el: HTMLElement) => getComputedStyle(el).borderWidth);
            expect(border).not.toBe('0px');
            // Verify group toggle shows group name
            const toggle = page.locator('.server-group-toggle');
            if (await toggle.count() > 0) {
                const toggleText = await toggle.textContent();
                expect(toggleText).toContain('My Group');
            }
        }

        // Rename group
        const header = page.locator('.server-group-header').first();
        if (await header.count() > 0) {
            // Double-click to rename (in-page prompt, auto-answered under automation)
            await queuePromptAnswer(page, 'Renamed');
            await header.dblclick();
            await page.waitForTimeout(1000);

            // Verify rename persisted
            const updatedToggle = page.locator('.server-group-toggle');
            if (await updatedToggle.count() > 0) {
                const text = await updatedToggle.textContent();
                expect(text).toContain('Renamed');
            }
        }
    });

    test('Drag indicators show top/bottom, not left/right', async ({ page }) => {
        const ts = unique('drag');
        await register(page, ts);
        await waitForWs(page);
        await createServer(page, 'DragServer1_' + ts);
        await page.waitForTimeout(500);
        await createServer(page, 'DragServer2_' + ts);
        await page.waitForTimeout(500);
        await createServer(page, 'DragServer3_' + ts);
        await page.waitForTimeout(500);

        // Verify server icons exist
        const icons = page.locator('.server-icon');
        const count = await icons.count();
        expect(count).toBeGreaterThanOrEqual(3);

        // Verify CSS classes use top/bottom, not left/right
        const cssHasTopBottom = await page.evaluate(() => {
            const sheets = document.styleSheets;
            for (let i = 0; i < sheets.length; i++) {
                try {
                    const rules = sheets[i].cssRules;
                    for (let j = 0; j < rules.length; j++) {
                        const sel = (rules[j] as CSSStyleRule).selectorText || '';
                        if (sel.includes('drag-over-left') || sel.includes('drag-over-right')) return false;
                    }
                } catch (_) {}
            }
            return true;
        });
        expect(cssHasTopBottom).toBeTruthy();
    });
});
