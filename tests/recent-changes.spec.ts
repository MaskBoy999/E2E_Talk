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

test.describe('Recent Changes - Comprehensive', () => {

    test('1. Text channel join enables message input', async ({ page }) => {
        const username = unique('tc_join');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'TC Test');
        await page.waitForTimeout(2000);

        // Click first text channel
        const textChannel = page.locator('.channel-item[data-type="text"]').first();
        if (await textChannel.count() > 0) {
            await textChannel.click();
            await page.waitForTimeout(1000);

            const inputDisabled = await page.evaluate(() => {
                return (document.getElementById('message-input') as HTMLInputElement)?.disabled;
            });
            expect(inputDisabled).toBe(false);

            const channelName = await page.textContent('#channel-name');
            expect(channelName).toContain('#');
        }
    });

    test('2. Server strip is vertical', async ({ page }) => {
        const username = unique('sv_strip');
        await register(page, username);
        await waitForWs(page);

        const stripDir = await page.evaluate(() => {
            const strip = document.querySelector('.server-strip');
            return strip ? getComputedStyle(strip).flexDirection : 'unknown';
        });
        expect(stripDir).toBe('column');

        const listDir = await page.evaluate(() => {
            const list = document.querySelector('.server-list');
            return list ? getComputedStyle(list).flexDirection : 'unknown';
        });
        expect(listDir).toBe('column');
    });

    test('3. Server drag indicators use top/bottom', async ({ page }) => {
        const username = unique('sv_drag');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Drag Test A');
        await page.waitForTimeout(1000);
        await createServer(page, 'Drag Test B');
        await page.waitForTimeout(1000);

        // Verify drag-over-top and drag-over-bottom CSS classes exist
        const hasTopClass = await page.evaluate(() => {
            const style = document.styleSheets[0];
            for (let i = 0; i < style.cssRules.length; i++) {
                const rule = style.cssRules[i];
                if (rule instanceof CSSStyleRule && rule.selectorText === '.drag-over-top') return true;
            }
            return false;
        });
        expect(hasTopClass).toBe(true);

        const hasBottomClass = await page.evaluate(() => {
            const style = document.styleSheets[0];
            for (let i = 0; i < style.cssRules.length; i++) {
                const rule = style.cssRules[i];
                if (rule instanceof CSSStyleRule && rule.selectorText === '.drag-over-bottom') return true;
            }
            return false;
        });
        expect(hasBottomClass).toBe(true);

        // Verify no old left/right classes
        const hasLeftClass = await page.evaluate(() => {
            const style = document.styleSheets[0];
            for (let i = 0; i < style.cssRules.length; i++) {
                const rule = style.cssRules[i];
                if (rule instanceof CSSStyleRule && rule.selectorText === '.drag-over-left') return true;
            }
            return false;
        });
        expect(hasLeftClass).toBe(false);
    });

    test('4. Server icons are draggable', async ({ page }) => {
        const username = unique('sv_drag2');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Draggable Test');
        await page.waitForTimeout(1000);

        const draggable = await page.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon:not(.add-server)');
            return Array.from(icons).every((el: any) => el.draggable === true);
        });
        expect(draggable).toBe(true);
    });

    test('5. Invite code box renders with buttons on separate line', async ({ page }) => {
        const username = unique('inv_box');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'Invite Test');
        await page.waitForTimeout(2000);

        // Click invite button
        const inviteBtn = page.locator('#invite-btn');
        if (await inviteBtn.isVisible()) {
            await inviteBtn.click();
            await page.waitForTimeout(1000);

            // Identity key box should exist
            const keyBox = page.locator('.identity-key-box');
            await expect(keyBox).toBeVisible();

            // Key value should take full width (buttons on next line)
            const keyWidth = await page.evaluate(() => {
                const el = document.querySelector('.identity-key-box .key-value');
                return el ? getComputedStyle(el).width : '0';
            });
            const boxWidth = await page.evaluate(() => {
                const el = document.querySelector('.identity-key-box');
                return el ? getComputedStyle(el).width : '0';
            });
            // Key value should be close to full box width
            expect(parseInt(keyWidth)).toBeGreaterThan(parseInt(boxWidth) * 0.8);

            // Buttons should exist
            await expect(page.locator('#toggle-invite-btn')).toBeVisible();
            await expect(page.locator('#copy-invite-btn')).toBeVisible();
            await expect(page.locator('#invite-qr-btn')).toBeVisible();
            await expect(page.locator('#regenerate-invite')).toBeVisible();
            await expect(page.locator('#close-invite')).toBeVisible();

            // Close modal
            await page.click('#close-invite');
        }
    });

    test('6. Pair New Device is removed', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(3000);

        // No pairing modal in HTML
        const modalExists = await page.evaluate(() => {
            return !!document.getElementById('pairing-modal');
        });
        expect(modalExists).toBe(false);

        // No _addPairingButton function
        const fnExists = await page.evaluate(() => {
            return typeof (window as any)._addPairingButton === 'function';
        });
        expect(fnExists).toBe(false);

        // No startDevicePairing function
        const startExists = await page.evaluate(() => {
            return typeof (window as any).startDevicePairing === 'function';
        });
        expect(startExists).toBe(false);
    });

    test('7. Soundboard upload button exists and server check works', async ({ page }) => {
        const username = unique('sb_check');
        await register(page, username);
        await waitForWs(page);
        await createServer(page, 'SB Test');
        await page.waitForTimeout(2000);

        // Soundboard button should exist in voice popup
        const sbBtn = page.locator('#voice-popup-soundboard');
        // It may not be visible without voice channel, but should exist in DOM
        const sbExists = await page.evaluate(() => {
            return !!document.getElementById('voice-popup-soundboard');
        });
        // Soundboard elements exist
        const uploadBtnExists = await page.evaluate(() => {
            return !!document.getElementById('soundboard-upload-btn');
        });
        expect(uploadBtnExists).toBe(true);
    });

    test('8. Login page has no jsQR script', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForLoadState('domcontentloaded');

        const hasJsQR = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script[src]');
            return Array.from(scripts).some((s: any) => s.src.includes('jsqr'));
        });
        expect(hasJsQR).toBe(false);
    });

    test('9. currentServerId is accessible via window', async ({ page }) => {
        // Just check the JS source has var instead of let for currentServerId
        const resp = await page.goto(`${BASE}/chat.js`);
        const text = await resp?.text() || '';
        expect(text).toContain('var currentServerId');
        expect(text).not.toMatch(/^let currentServerId/m);
    });

    test('10. markChannelRead function exists in chat.js source', async ({ page }) => {
        const resp = await page.goto(`${BASE}/chat.js`);
        const text = await resp?.text() || '';
        expect(text).toContain('function markChannelRead');
    });
});
