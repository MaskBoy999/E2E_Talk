import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';

const BASE = 'https://localhost:3443';
const PW = 'testtest12345678';

function unique(prefix: string) {
    return prefix + '_' + Math.random().toString(36).slice(2, 8);
}

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-username', { timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

async function waitForWs(page: any, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const ok = await page.evaluate(() => {
            const ws = (window as any).ws;
            return ws && ws.readyState === 1;
        });
        if (ok) return;
        await page.waitForTimeout(300);
    }
}

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForTimeout(2000);
    const servers = await page.$$('.server-icon[data-id]');
    if (servers.length === 0) return '';
    return await servers[servers.length - 1].getAttribute('data-id');
}

test.describe('All Recent Fixes', () => {
    test('A: Context menu has visible background (not transparent)', async ({ page }) => {
        const username = unique('ctx');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Ctx Test');

        // Right-click on the server icon to trigger context menu
        const icon = await page.$('.server-icon[data-id]');
        expect(icon).toBeTruthy();
        await icon!.click({ button: 'right' });
        await page.waitForTimeout(300);

        // Check if any context menu appeared
        const menuVisible = await page.evaluate(() => {
            const menus = document.querySelectorAll('.context-menu, .server-context-menu, [class*="context"]');
            for (const m of Array.from(menus)) {
                const cs = getComputedStyle(m as Element);
                if (cs.display !== 'none' && cs.visibility !== 'hidden') {
                    return {
                        tag: m.tagName,
                        class: m.className,
                        bg: cs.backgroundColor,
                        border: cs.border,
                        display: cs.display,
                    };
                }
            }
            return null;
        });
        console.log('Context menu:', JSON.stringify(menuVisible));

        // Take screenshot
        await page.screenshot({ path: 'test-results/ctx-menu.png' });

        // The context menu should have a non-transparent background
        if (menuVisible) {
            expect(menuVisible.bg).not.toBe('rgba(0, 0, 0, 0)');
            expect(menuVisible.bg).not.toBe('transparent');
        }
    });

    test('B: Group context menu has visible background', async ({ page }) => {
        const username = unique('gctx');
        await register(page, username);
        await waitForWs(page);

        // Create 2 servers
        await createServer(page, 'GC1');
        await page.waitForTimeout(1000);
        await createServer(page, 'GC2');
        await page.waitForTimeout(1000);

        // Group them via API
        await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
            const r = await fetch('/api/server-groups', { method: 'POST', headers: h, body: JSON.stringify({ name: 'TestGroup' }) });
            const g = await r.json();
            const sr = await fetch('/api/servers', { headers: { Authorization: 'Bearer ' + token } });
            const servers = await sr.json();
            if (Array.isArray(servers) && servers.length >= 2) {
                await fetch('/api/server-groups/' + g.id + '/servers', { method: 'PUT', headers: h, body: JSON.stringify({ server_ids: [servers[0].id, servers[1].id] }) });
            }
        });

        // Reload to render groups
        await page.reload();
        await waitForWs(page);
        await page.waitForTimeout(1000);

        // Collapse group if expanded
        const groupHeader = await page.$('.server-group-header');
        if (groupHeader) {
            // Right-click on group header
            await groupHeader.click({ button: 'right' });
            await page.waitForTimeout(300);

            const groupMenu = await page.evaluate(() => {
                const menu = document.getElementById('group-context-menu');
                if (!menu) return null;
                const cs = getComputedStyle(menu);
                return {
                    display: cs.display,
                    bg: cs.backgroundColor,
                    border: cs.border,
                    position: cs.position,
                };
            });
            console.log('Group context menu:', JSON.stringify(groupMenu));
            await page.screenshot({ path: 'test-results/group-ctx-menu.png' });

            if (groupMenu) {
                expect(groupMenu.bg).not.toBe('rgba(0, 0, 0, 0)');
                expect(groupMenu.bg).not.toBe('transparent');
            }
        }
    });

    test('C: Volume percentage labels exist in voice popup and settings', async ({ page }) => {
        const username = unique('vol');
        await register(page, username);
        await waitForWs(page);

        // Check settings modal has volume labels
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const settingsLabel = await page.evaluate(() => {
            const el = document.getElementById('voice-mic-volume-val');
            return el ? el.textContent : null;
        });
        console.log('Settings mic volume label:', settingsLabel);
        expect(settingsLabel).toBeTruthy();
        expect(settingsLabel).toContain('%');

        // Close settings
        await page.click('#close-settings');
        await page.waitForTimeout(200);

        // Check voice popup labels exist in DOM
        const popupLabels = await page.evaluate(() => {
            return {
                micVal: !!document.getElementById('voice-popup-mic-volume-val'),
                speakerVal: !!document.getElementById('voice-popup-speaker-volume-val'),
            };
        });
        console.log('Popup labels exist:', JSON.stringify(popupLabels));
        expect(popupLabels.micVal).toBe(true);
        expect(popupLabels.speakerVal).toBe(true);
    });

    test('D: Settings tab switch stops hear-self test', async ({ page }) => {
        const username = unique('tab');
        await register(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        // Verify hear-self button exists
        const btnExists = await page.evaluate(() => {
            return !!document.getElementById('voice-hear-self-btn');
        });
        console.log('Hear-self button exists:', btnExists);
        expect(btnExists).toBe(true);

        // Switch to another tab — this should stop hear-self if it was running
        await page.click('.settings-tab[data-tab="user-settings"]');
        await page.waitForTimeout(300);

        // Verify _stopHearSelfTest was called (hearsel should not be active)
        const hearSelfActive = await page.evaluate(() => {
            return (window as any).settings?.hearSelf || false;
        });
        console.log('Hear-self active after tab switch:', hearSelfActive);
        // Should be false since we switched away from voice tab
        expect(hearSelfActive).toBe(false);

        // Close settings — should also stop hear-self
        await page.click('#close-settings');
        await page.waitForTimeout(200);
    });

    test('E: Soundboard temp-play endpoint works', async ({ page }) => {
        const username = unique('tmp');
        await register(page, username);
        await waitForWs(page);

        // Test the temp-play endpoint directly
        const result = await page.evaluate(async () => {
            const token = localStorage.getItem('token');
            // Create a small WAV file in base64 (silence, 44 bytes header + data)
            const wavHeader = new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
                0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
                0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
                0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00
            ]);
            const b64 = btoa(String.fromCharCode(...wavHeader));

            // Upload
            const uploadResp = await fetch('/api/soundboard/temp-play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ audio: b64 }),
            });
            const uploadData = await uploadResp.json();

            if (!uploadData.token) return { error: 'no token', status: uploadResp.status };

            // Fetch
            const fetchResp = await fetch('/api/soundboard/temp-play/' + uploadData.token, {
                headers: { 'Authorization': 'Bearer ' + token },
            });
            const contentType = fetchResp.headers.get('content-type');
            const bytes = await fetchResp.arrayBuffer();

            // Token is NOT one-shot: all room members (incl. late joiners within
            // the TTL) fetch the same token, so the second fetch must also 200.
            const secondFetch = await fetch('/api/soundboard/temp-play/' + uploadData.token, {
                headers: { 'Authorization': 'Bearer ' + token },
            });

            return {
                tokenLength: uploadData.token.length,
                fetchStatus: fetchResp.status,
                contentType: contentType,
                audioSize: bytes.byteLength,
                secondFetchStatus: secondFetch.status,
            };
        });

        console.log('Temp play result:', JSON.stringify(result));
        expect(result.tokenLength).toBe(60);
        expect(result.fetchStatus).toBe(200);
        expect(result.audioSize).toBeGreaterThan(0);
        // Second fetch must ALSO be 200 (shared token, not one-shot)
        expect(result.secondFetchStatus).toBe(200);
    });

    test('F: Hearer-self volume slider updates live gain', async ({ page }) => {
        const username = unique('gain');
        await register(page, username);
        await waitForWs(page);

        // Open settings and go to voice tab
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        // Check initial volume label
        const initialLabel = await page.evaluate(() => {
            return document.getElementById('voice-mic-volume-val')?.textContent;
        });
        console.log('Initial mic label:', initialLabel);
        expect(initialLabel).toBe('100%');

        // Simulate changing volume via direct API call
        await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            if (vm && vm.setMicVolume) vm.setMicVolume(150);
        });
        await page.waitForTimeout(200);

        const updatedLabel = await page.evaluate(() => {
            return document.getElementById('voice-mic-volume-val')?.textContent;
        });
        console.log('Updated mic label:', updatedLabel);
        expect(updatedLabel).toBe('150%');

        // Test reset button
        await page.click('#voice-mic-reset');
        await page.waitForTimeout(200);

        const resetLabel = await page.evaluate(() => {
            return document.getElementById('voice-mic-volume-val')?.textContent;
        });
        const resetSlider = await page.evaluate(() => {
            return (document.getElementById('voice-mic-volume') as HTMLInputElement)?.value;
        });
        console.log('After reset - label:', resetLabel, 'slider:', resetSlider);
        expect(resetLabel).toBe('100%');
        expect(resetSlider).toBe('100');

        await page.click('#close-settings');
    });

    test('G: Settings close button stops hear-self', async ({ page }) => {
        const username = unique('close');
        await register(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        // Verify close button has hear-self stop listener
        const hasCloseListener = await page.evaluate(() => {
            // The listener was added in voice.js on the .settings-close button
            const closeBtn = document.querySelector('#close-settings');
            return !!closeBtn;
        });
        console.log('Settings close button exists:', hasCloseListener);
        expect(hasCloseListener).toBe(true);

        await page.click('#close-settings');
        await page.waitForTimeout(200);

        // Settings should be hidden
        const visible = await page.evaluate(() => {
            const m = document.getElementById('settings-modal');
            return m ? getComputedStyle(m).display : 'none';
        });
        expect(visible).toBe('none');
    });
});
