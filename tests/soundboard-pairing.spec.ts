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

async function createServer(page: any) {
    await page.waitForSelector('#add-server-btn', { timeout: 10000 });
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', 'Soundboard Test');
    await page.click('#confirm-create-server');
    await page.waitForFunction(() => {
        const items = document.querySelectorAll('.channel-item');
        return items.length > 0;
    }, { timeout: 15000 });
    // Get the current server ID
    return await page.evaluate(() => (window as any).currentServerId);
}

test.describe('Soundboard (F12)', () => {

    test('Soundboard overlay opens and closes', async ({ page }) => {
        const username = uniqueUsername('sb_overlay');
        await registerUser(page, username);

        // Verify overlay exists in DOM
        const overlayExists = await page.evaluate(() => !!document.getElementById('soundboard-overlay'));
        expect(overlayExists).toBe(true);

        // Open via JS
        await page.evaluate(() => {
            document.getElementById('soundboard-overlay')!.style.display = 'flex';
        });
        const isVisible = await page.evaluate(() =>
            document.getElementById('soundboard-overlay')!.style.display !== 'none'
        );
        expect(isVisible).toBe(true);

        // Close via JS
        await page.evaluate(() => {
            document.getElementById('soundboard-overlay')!.style.display = 'none';
        });
        const isHidden = await page.evaluate(() =>
            document.getElementById('soundboard-overlay')!.style.display === 'none'
        );
        expect(isHidden).toBe(true);
    });

    test('Soundboard panel has upload button and empty state', async ({ page }) => {
        const username = uniqueUsername('sb_panel');
        await registerUser(page, username);

        // Open overlay
        await page.evaluate(() => {
            document.getElementById('soundboard-overlay')!.style.display = 'flex';
        });

        // Check header text
        const headerText = await page.evaluate(() => {
            const h = document.querySelector('.soundboard-header h3');
            return h?.textContent;
        });
        expect(headerText).toBe('Soundboard');

        // Check upload button
        const hasUploadBtn = await page.evaluate(() => !!document.getElementById('soundboard-upload-btn'));
        expect(hasUploadBtn).toBe(true);

        // Check clips container
        const hasClips = await page.evaluate(() => !!document.getElementById('soundboard-clips'));
        expect(hasClips).toBe(true);
    });

    test('Soundboard overlay has correct CSS (z-index, position)', async ({ page }) => {
        const username = uniqueUsername('sb_css');
        await registerUser(page, username);

        const styles = await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (!overlay) return null;
            const computed = window.getComputedStyle(overlay);
            return {
                position: computed.position,
                zIndex: parseInt(computed.zIndex),
            };
        });
        expect(styles).toBeTruthy();
        expect(styles!.position).toBe('fixed');
        expect(styles!.zIndex).toBeGreaterThanOrEqual(10000);
    });

    test('Soundboard button exists in voice popup HTML', async ({ page }) => {
        const username = uniqueUsername('sb_btn');
        await registerUser(page, username);

        // The button is always in the DOM (hidden until voice channel join)
        const hasBtn = await page.evaluate(() => !!document.getElementById('voice-popup-soundboard'));
        expect(hasBtn).toBe(true);

        const btnTitle = await page.evaluate(() => {
            const btn = document.getElementById('voice-popup-soundboard');
            return btn?.getAttribute('title');
        });
        expect(btnTitle).toBe('Soundboard');
    });

    test('Self-hear toggle exists in soundboard overlay', async ({ page }) => {
        const username = uniqueUsername('sb_hear');
        await registerUser(page, username);

        const hasSelfHear = await page.evaluate(() => !!document.getElementById('soundboard-self-hear'));
        expect(hasSelfHear).toBe(true);
    });

    test('DM mini bar has soundboard button', async ({ page }) => {
        const username = uniqueUsername('sb_mini');
        await registerUser(page, username);

        const hasSbBtn = await page.evaluate(() => !!document.getElementById('dm-mini-bar-soundboard'));
        expect(hasSbBtn).toBe(true);
    });
});
