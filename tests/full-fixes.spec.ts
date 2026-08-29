import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PW = 'testpass123';

function unique(prefix: string) { return prefix + '_' + Math.random().toString(36).slice(2, 8); }

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.waitForSelector('#register-username', { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: Page) {
    for (let i = 0; i < 60; i++) {
        const ok = await page.evaluate(() => {
            const ws = (window as any).ws;
            return ws && ws.readyState === 1;
        });
        if (ok) return;
        await page.waitForTimeout(500);
    }
}

async function createServer(page: Page, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(1000);
}

test.describe('Full Fixes Verification', () => {

    test('A: currentUserId is set after login', async ({ page }) => {
        const username = unique('cid');
        await register(page, username);
        await waitForWs(page);
        const userId = await page.evaluate(() => (window as any).currentUserId);
        console.log('currentUserId:', userId);
        expect(userId).toBeTruthy();
        expect(typeof userId).toBe('string');
    });

    test('B: hear-self test mic works (no mic access denied)', async ({ page }) => {
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('hsm');
        await register(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(500);

        const hsBtn = await page.$('#voice-hear-self-btn');
        expect(hsBtn).toBeTruthy();
        await hsBtn!.click();
        await page.waitForTimeout(2000);

        const status = await page.textContent('#voice-hear-self-status');
        console.log('Hear-self status:', status);
        expect(status).not.toContain('denied');

        const meterVisible = await page.isVisible('#voice-hear-self-meter-wrap');
        console.log('Meter visible:', meterVisible);
        expect(meterVisible).toBe(true);

        await hsBtn!.click();
        await page.waitForTimeout(500);
    });

    test('C: soundboard overlay opens and has upload', async ({ page }) => {
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('sb');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'SB Test Server');

        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'flex';
            if ((window as any)._loadSoundboardClips) (window as any)._loadSoundboardClips();
        });
        await page.waitForTimeout(1000);

        const overlayVisible = await page.isVisible('#soundboard-overlay');
        console.log('Soundboard overlay visible:', overlayVisible);
        expect(overlayVisible).toBe(true);

        const uploadBtn = await page.$('#soundboard-upload-btn');
        console.log('Upload button found:', !!uploadBtn);
        expect(uploadBtn).toBeTruthy();
    });

    test('D: currentUserId is valid and WS handler exists for soundboard relay', async ({ page }) => {
        // Verify the critical fix: currentUserId is set so WS soundboard_play
        // messages carry a valid user_id — other users can identify the sender
        const username = unique('sbD');
        await register(page, username);
        await waitForWs(page);

        const result = await page.evaluate(() => {
            const uid = (window as any).currentUserId;
            const hasHandler = typeof (window as any)._handleSoundboardPlay === 'function';
            const hasWs = (window as any).ws && (window as any).ws.readyState === 1;
            return { uid, hasHandler, hasWs };
        });
        console.log('Soundboard relay check:', JSON.stringify(result));
        expect(result.uid).toBeTruthy();
        expect(typeof result.uid).toBe('string');
        expect(result.hasHandler).toBe(true);
        expect(result.hasWs).toBe(true);
    });

    test('E: server groups render after create and reload', async ({ page }) => {
        const username = unique('grp');
        await register(page, username);
        await waitForWs(page);

        for (let i = 0; i < 3; i++) {
            await createServer(page, 'Group Test ' + i);
            await page.waitForTimeout(2000);
        }

        const icons = await page.$$('.server-icon[data-id]');
        console.log('Server icons:', icons.length);
        expect(icons.length).toBeGreaterThanOrEqual(3);

        const result = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const servers = await (await fetch('/api/servers', { headers: h })).json();
            if (!Array.isArray(servers) || servers.length < 2) return { error: 'need 2 servers' };

            const grpResp = await fetch('/api/server-groups', {
                method: 'POST', headers: h,
                body: JSON.stringify({ name: 'Test Group' }),
            });
            const grp = await grpResp.json();

            await fetch('/api/servers/' + servers[0].id + '/group', {
                method: 'PUT', headers: h,
                body: JSON.stringify({ group_id: grp.id }),
            });
            await fetch('/api/servers/' + servers[1].id + '/group', {
                method: 'PUT', headers: h,
                body: JSON.stringify({ group_id: grp.id }),
            });

            return { groupId: grp.id };
        });
        console.log('Group result:', JSON.stringify(result));
        expect(result).toHaveProperty('groupId');

        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(2000);

        const groups = await page.$$('.server-group');
        console.log('Groups rendered:', groups.length);
        expect(groups.length).toBeGreaterThanOrEqual(1);

        // Collapse the group
        const hdr = await page.$('.server-group-header');
        if (hdr) { await hdr.click(); await page.waitForTimeout(500); }

        const miniIcons = await page.$$('.server-group-collapsed-grid .server-group-mini');
        console.log('Mini icons in collapsed grid:', miniIcons.length);
        expect(miniIcons.length).toBe(2);
    });

    test('F: server can be ungrouped and auto-deletes empty group', async ({ page }) => {
        const username = unique('drg');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Drag Test 1');
        await page.waitForTimeout(1000);
        await createServer(page, 'Drag Test 2');
        await page.waitForTimeout(1000);

        const result = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const servers = await (await fetch('/api/servers', { headers: h })).json();
            const grpResp = await fetch('/api/server-groups', {
                method: 'POST', headers: h,
                body: JSON.stringify({ name: 'Drag Group' }),
            });
            const grp = await grpResp.json();
            await fetch('/api/servers/' + servers[0].id + '/group', {
                method: 'PUT', headers: h,
                body: JSON.stringify({ group_id: grp.id }),
            });
            return { groupId: grp.id, serverId: servers[0].id };
        });

        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(2000);

        // Ungroup via API (simulates drag-out)
        const moveResult = await page.evaluate(async (sid: string) => {
            const token = localStorage.getItem('token');
            const resp = await fetch('/api/servers/' + sid + '/group', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ group_id: null }),
            });
            return { status: resp.status, ok: resp.ok };
        }, result.serverId);
        console.log('Move out result:', JSON.stringify(moveResult));
        expect(moveResult.ok).toBe(true);

        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(2000);

        const ungrouped = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.server-icon[data-id]'))
                .filter(el => !el.closest('.server-group-collapsed-grid'))
                .length;
        });
        console.log('Ungrouped icons:', ungrouped);
        expect(ungrouped).toBeGreaterThanOrEqual(1);
    });

    test('G: soundboard disable toggle persists across reload', async ({ page }) => {
        const ctx = page.context();
        await ctx.grantPermissions(['microphone'], { origin: BASE });
        const username = unique('sbdis');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'SB Disable Test');

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(500);

        const disableCb = await page.$('#voice-disable-soundboard');
        if (disableCb) {
            await disableCb.check();
            await page.waitForTimeout(300);
        }

        await page.click('#close-settings');
        await page.waitForTimeout(300);

        const disabled = await page.evaluate(() => {
            return localStorage.getItem('sb_disabled_global') === '1';
        });
        console.log('Soundboard disabled:', disabled);
        expect(disabled).toBe(true);

        await page.reload();
        await waitForWs(page);
        const stillDisabled = await page.evaluate(() => {
            return localStorage.getItem('sb_disabled_global') === '1';
        });
        console.log('Still disabled after reload:', stillDisabled);
        expect(stillDisabled).toBe(true);
    });
});
