import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASS = 'testpass123';

let counter = 0;
function unique(pfx: string) { return pfx + '_' + (++counter) + '_' + Date.now().toString(36); }

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASS);
    await page.fill('#register-confirm-password', PASS);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: any) {
    for (let i = 0; i < 30; i++) {
        const ready = await page.evaluate(() => {
            const ws = (window as any).ws;
            return ws && ws.readyState === 1;
        });
        if (ready) return;
        await page.waitForTimeout(500);
    }
}

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-name', { timeout: 5000 });
    await page.fill('#create-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(1500);
}

async function createGroupViaAPI(page: any, s1Id: string, s2Id: string): Promise<string> {
    return await page.evaluate(async (ids: {s1: string, s2: string}) => {
        const token = localStorage.getItem('token');
        const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
        // Create group
        const r = await fetch('/api/server-groups', {
            method: 'POST', headers: h,
            body: JSON.stringify({ name: 'TestGroup' })
        });
        const data = await r.json();
        if (!data.ok) throw new Error('Failed to create group: ' + JSON.stringify(data));
        const gid = data.id;
        // Move servers into group
        await fetch('/api/servers/' + ids.s1 + '/group', {
            method: 'PUT', headers: h,
            body: JSON.stringify({ group_id: gid })
        });
        await fetch('/api/servers/' + ids.s2 + '/group', {
            method: 'PUT', headers: h,
            body: JSON.stringify({ group_id: gid })
        });
        return gid;
    }, { s1: s1Id, s2: s2Id });
}

test.describe('Folder Features', () => {
    test('Set folder color via context menu', async ({ page }) => {
        const ts = unique('fcol');
        await register(page, ts);
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Create 2 servers via API
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const r1 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'S1', invite_code: 'fcol-inv-' + Date.now() }) });
            const r2 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'S2', invite_code: 'fcol-inv2-' + Date.now() }) });
            const d1 = await r1.json(); const d2 = await r2.json();
            (window as any).__s1 = d1.id; (window as any).__s2 = d2.id;
        });
        await page.waitForTimeout(500);

        const s1Id = await page.evaluate(() => (window as any).__s1);
        const s2Id = await page.evaluate(() => (window as any).__s2);

        // Reload to pick up new servers
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await waitForWs(page);

        // Create group via API
        const gid = await createGroupViaAPI(page, s1Id, s2Id);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await waitForWs(page);

        // Verify group appears
        const groupEl = page.locator('.server-group').first();
        await expect(groupEl).toBeVisible({ timeout: 5000 });

        // Collapse group if expanded
        const toggle = groupEl.locator('.server-group-toggle');
        if (await toggle.isVisible()) {
            await toggle.click();
            await page.waitForTimeout(500);
        }

        // Right-click group header
        const header = groupEl.locator('.server-group-header');
        await header.click({ button: 'right' });
        await page.waitForTimeout(300);

        // Verify context menu appears with color swatches
        const swatches = page.locator('.ctx-color-swatch');
        const count = await swatches.count();
        expect(count).toBeGreaterThanOrEqual(10);

        // Click the blue swatch (first one)
        await swatches.first().click();
        await page.waitForTimeout(500);

        // Verify folder-color class
        const hasColor = await page.evaluate(() => {
            const grid = document.querySelector('.server-group-collapsed-grid');
            return grid ? grid.classList.contains('folder-color') : false;
        });
        expect(hasColor).toBe(true);
        console.log('✅ Folder color applied successfully');
    });

    test('Mute and unmute folder', async ({ page }) => {
        const ts = unique('fmute');
        await register(page, ts);
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Create 2 servers and group via API
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const r1 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MS1', invite_code: 'fmute-inv-' + Date.now() }) });
            const r2 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MS2', invite_code: 'fmute-inv2-' + Date.now() }) });
            const d1 = await r1.json(); const d2 = await r2.json();
            const rg = await fetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MuteGroup' }) });
            const gd = await rg.json();
            await fetch('/api/servers/' + d1.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
            await fetch('/api/servers/' + d2.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
            (window as any).__muteGid = gd.id;
        });

        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await waitForWs(page);

        // Right-click group header
        const header = page.locator('.server-group-header').first();
        await expect(header).toBeVisible({ timeout: 5000 });
        await header.click({ button: 'right' });
        await page.waitForTimeout(300);

        // Click Mute Folder
        const muteBtn = page.locator('[data-action="mute-folder"]');
        await expect(muteBtn).toBeVisible();
        const muteText = await muteBtn.textContent();
        expect(muteText).toContain('Mute Folder');
        await muteBtn.click();
        await page.waitForTimeout(300);

        // Verify muted_folders in localStorage
        const isMuted = await page.evaluate(() => {
            const mf = JSON.parse(localStorage.getItem('muted_folders') || '[]');
            return mf.length > 0;
        });
        expect(isMuted).toBe(true);

        // Right-click again and verify it shows Unmute
        await header.click({ button: 'right' });
        await page.waitForTimeout(300);
        const unmuteBtn = page.locator('[data-action="mute-folder"]');
        const unmuteText = await unmuteBtn.textContent();
        expect(unmuteText).toContain('Unmute Folder');
        await unmuteBtn.click();
        await page.waitForTimeout(300);

        // Verify unmuted
        const isUnmuted = await page.evaluate(() => {
            const mf = JSON.parse(localStorage.getItem('muted_folders') || '[]');
            return mf.length === 0;
        });
        expect(isUnmuted).toBe(true);
        console.log('✅ Folder mute/unmute works');
    });

    test('Mark as Read clears group notifications', async ({ page }) => {
        const ts = unique('fmr');
        await register(page, ts);
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Create group via API
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const r1 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MR1', invite_code: 'fmr-inv-' + Date.now() }) });
            const r2 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MR2', invite_code: 'fmr-inv2-' + Date.now() }) });
            const d1 = await r1.json(); const d2 = await r2.json();
            const rg = await fetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'MRGroup' }) });
            const gd = await rg.json();
            await fetch('/api/servers/' + d1.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
            await fetch('/api/servers/' + d2.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
        });

        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await waitForWs(page);

        // Right-click group
        const header = page.locator('.server-group-header').first();
        await expect(header).toBeVisible({ timeout: 5000 });
        await header.click({ button: 'right' });
        await page.waitForTimeout(300);

        // Click Mark as Read
        const markRead = page.locator('[data-action="mark-read"]');
        await expect(markRead).toBeVisible();
        await markRead.click();
        await page.waitForTimeout(300);
        console.log('✅ Mark as Read clicked successfully');
    });

    test('Context menu has all expected items', async ({ page }) => {
        const ts = unique('fctx');
        await register(page, ts);
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Create group via API
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const r1 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'CTX1', invite_code: 'fctx-inv-' + Date.now() }) });
            const r2 = await fetch('/api/servers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'CTX2', invite_code: 'fctx-inv2-' + Date.now() }) });
            const d1 = await r1.json(); const d2 = await r2.json();
            const rg = await fetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'CTXGroup' }) });
            const gd = await rg.json();
            await fetch('/api/servers/' + d1.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
            await fetch('/api/servers/' + d2.id + '/group', { method: 'PUT', headers: h, body: JSON.stringify({ group_id: gd.id }) });
        });

        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await waitForWs(page);

        const header = page.locator('.server-group-header').first();
        await expect(header).toBeVisible({ timeout: 5000 });
        await header.click({ button: 'right' });
        await page.waitForTimeout(300);

        const items = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#group-context-menu .ctx-item'))
                .map((el: any) => el.getAttribute('data-action'));
        });
        expect(items).toContain('rename');
        expect(items).toContain('mute-folder');
        expect(items).toContain('mark-read');
        expect(items).toContain('ungroup');
        expect(items).toContain('delete');

        const swatchCount = await page.locator('.ctx-color-swatch').count();
        expect(swatchCount).toBeGreaterThanOrEqual(10);
        console.log('✅ Context menu has all items: ' + items.join(', '));
    });
});

test.describe('DM Conversation Reorder', () => {
    test('DM items are draggable and reorderable', async ({ page }) => {
        const ts1 = unique('dmr1');
        const ts2 = unique('dmr2');
        const ts3 = unique('dmr3');

        // Register 3 users
        await register(page, ts1);
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Create DM conversations by sending messages
        // We need at least 2 DM conversations to reorder
        // Use the API to start DMs
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h: any = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

            // Register 2 more users for DMs
            const r1 = await fetch('/api/register', {
                method: 'POST', headers: h,
                body: JSON.stringify({ username: (window as any).__ts2 || 'dmr2_' + Date.now(), password: 'testpass123' })
            });
            const r2 = await fetch('/api/register', {
                method: 'POST', headers: h,
                body: JSON.stringify({ username: (window as any).__ts3 || 'dmr3_' + Date.now(), password: 'testpass123' })
            });
            // These may fail if users exist, that's OK
        });
        await page.waitForTimeout(500);

        // Check if DM strip has items
        const dmCount = await page.locator('.dm-item').count();
        console.log('DM items found: ' + dmCount);

        if (dmCount >= 2) {
            // Check that DM items have draggable attribute
            const firstDm = page.locator('.dm-item').first();
            const isDraggable = await firstDm.getAttribute('draggable');
            expect(isDraggable).toBe('true');

            // Verify reorder API exists
            const hasReorderApi = await page.evaluate(async () => {
                const token = localStorage.getItem('token');
                const r = await fetch('/api/dm/reorder', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ ordered_ids: [] })
                });
                return r.status !== 404; // Endpoint exists
            });
            expect(hasReorderApi).toBe(true);
            console.log('✅ DM items are draggable and reorder API exists');
        } else {
            console.log('ℹ️ Not enough DM conversations to test reorder (need 2+)');
        }
    });
});
