// Icon packs save themselves now: there is no "Save & apply", every change is
// PUT to the encrypted server slot after a short debounce, and each icon has
// its own reset. This pins the two halves a user would notice — no manual save
// control exists, and a single-icon reset reaches the server on its own.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

test.describe('icon packs autosave', () => {
    test('an icon edit reaches the server with no Save click', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page, 'iconauto_' + Date.now());

        // Seed slot 1 with one custom icon, encrypted with the identity key the
        // way the tab itself does (so the tab decrypts it).
        const status = await page.evaluate(async () => {
            const key = E2ECrypto.getIdentityKeyPair().privateKey;
            const map = { copy: { inner: '<path d="M4 4h16v16H4z"/>', viewBox: '0 0 24 24' } };
            const enc = E2ECrypto.aeadEncrypt(JSON.stringify(map), key);
            const r = await fetch('/api/user-icons/slot/1', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ encrypted_icons: enc.ciphertext, nonce: enc.nonce }),
            });
            return r.status;
        });
        expect(status).toBe(200);

        // Render the Icons tab into a scratch container: the tab itself is
        // app-only, but the module is the same one the app drives.
        await page.evaluate(() => {
            const c = document.createElement('div');
            c.id = 'icon-autosave-host';
            document.body.appendChild(c);
            (window as unknown as { IconPacks: { renderTab: (el: HTMLElement) => void } }).IconPacks.renderTab(c);
        });
        await page.waitForSelector('#icon-autosave-host [data-icon-reset="copy"]', { timeout: 15000 });

        // No manual save control any more.
        expect(await page.locator('#icon-autosave-host button', { hasText: 'Save & apply' }).count()).toBe(0);

        // Resetting ONE icon must PUT the slot on its own.
        const [req] = await Promise.all([
            page.waitForRequest(
                (r) => r.method() === 'PUT' && r.url().includes('/api/user-icons/slot/1'),
                { timeout: 15000 },
            ),
            page.locator('#icon-autosave-host [data-icon-reset="copy"]').click(),
        ]);
        expect(req.method()).toBe('PUT');

        // The icon is built-in again, so its reset control is disabled…
        await expect(page.locator('#icon-autosave-host [data-icon-reset="copy"]')).toBeDisabled();
        // …and the status line confirms the server took it.
        await expect(page.locator('#icon-pack-status')).toContainText('Saved to slot 1');
    });
});
