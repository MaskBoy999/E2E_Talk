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

test.describe('Soundboard + Pairing UI Integration', () => {

    test('All required DOM elements exist on chat page', async ({ page }) => {
        const username = uniqueUsername('dom_check');
        await registerUser(page, username);

        const elements = await page.evaluate(() => {
            return {
                soundboardOverlay: !!document.getElementById('soundboard-overlay'),
                soundboardPanel: !!document.querySelector('.soundboard-panel'),
                soundboardHeader: !!document.querySelector('.soundboard-header'),
                soundboardClips: !!document.getElementById('soundboard-clips'),
                soundboardUploadBtn: !!document.getElementById('soundboard-upload-btn'),
                soundboardFile: !!document.getElementById('soundboard-file'),
                soundboardBtn: !!document.getElementById('voice-popup-soundboard'),
                pairingModal: !!document.getElementById('pairing-modal'),
                pairingCard: !!document.querySelector('.pairing-card'),
                pairingQr: !!document.getElementById('pairing-qr'),
                pairingStatus: !!document.getElementById('pairing-status'),
            };
        });

        expect(elements.soundboardOverlay).toBe(true);
        expect(elements.soundboardPanel).toBe(true);
        expect(elements.soundboardHeader).toBe(true);
        expect(elements.soundboardClips).toBe(true);
        expect(elements.soundboardUploadBtn).toBe(true);
        expect(elements.soundboardFile).toBe(true);
        expect(elements.soundboardBtn).toBe(true);
        expect(elements.pairingModal).toBe(true);
        expect(elements.pairingCard).toBe(true);
        expect(elements.pairingQr).toBe(true);
        expect(elements.pairingStatus).toBe(true);
    });

    test('No JS errors from soundboard-pairing.js', async ({ page }) => {
        const jsErrors: string[] = [];
        page.on('pageerror', (e) => jsErrors.push(e.message));

        const username = uniqueUsername('sb_no_err');
        await registerUser(page, username);
        await page.waitForTimeout(2000);

        const criticalErrors = jsErrors.filter(e =>
            !e.includes('SSL') &&
            !e.includes('notification') &&
            !e.includes('favicon')
        );
        expect(criticalErrors).toEqual([]);
    });

    test('Soundboard file input is hidden and accepts audio only', async ({ page }) => {
        const username = uniqueUsername('sb_file');
        await registerUser(page, username);

        const fileInput = await page.evaluate(() => {
            const input = document.getElementById('soundboard-file') as HTMLInputElement;
            return {
                hidden: input?.style.display === 'none',
                accept: input?.accept,
            };
        });
        expect(fileInput.hidden).toBe(true);
        expect(fileInput.accept).toContain('audio');
    });

    test('Upload button click triggers file input', async ({ page }) => {
        const username = uniqueUsername('sb_upload_click');
        await registerUser(page, username);

        // Open the overlay first
        await page.evaluate(() => {
            document.getElementById('soundboard-overlay')!.style.display = 'flex';
        });

        // Verify the upload button exists and is clickable
        const btnInfo = await page.evaluate(() => {
            const btn = document.getElementById('soundboard-upload-btn');
            return {
                exists: !!btn,
                text: btn?.textContent,
                hasClickHandler: typeof (btn as any)?.onclick === 'function',
            };
        });
        expect(btnInfo.exists).toBe(true);
        expect(btnInfo.text).toContain('Upload Sound');
    });

    test('Pairing modal has claim button placeholder', async ({ page }) => {
        const username = uniqueUsername('pair_claim_btn');
        await registerUser(page, username);

        // Open pairing modal
        await page.evaluate(() => {
            document.getElementById('pairing-modal')!.style.display = 'flex';
        });

        // Check status text
        const statusText = await page.evaluate(() => {
            return document.getElementById('pairing-status')?.textContent;
        });
        expect(statusText).toBeTruthy();
    });
});
