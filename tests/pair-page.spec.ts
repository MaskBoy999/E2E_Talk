import { test, expect, type Page } from '@playwright/test';

// The pairing page's logic used to be an inline <script> with an inline
// `onclick=` on the generated Claim button and on Restore Keys. Both are gone:
// pair.js is an external file and the buttons carry real listeners, which is
// what makes them still work under a script-src with no 'unsafe-inline'. No
// other spec loaded pair.html, so this is its coverage.
const BASE = 'https://localhost:3443';

async function register(page: Page) {
    const username = `pairpage_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

test.describe('pairing page (external script, no inline handlers)', () => {
    test('a ticket renders with a working Claim button', async ({ page }) => {
        await register(page);

        const ticket = await page.evaluate(async () => {
            const res = await fetch('/api/pairing', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    public_key: btoa('pub'),
                    encrypted_key_blob: btoa('blob'),
                    key_blob_nonce: btoa('nonce'),
                }),
            });
            return res.json();
        });
        expect(ticket.ticket_id).toBeTruthy();

        await page.goto(`${BASE}/pair.html?ticket=${ticket.ticket_id}`);
        await expect(page.locator('#pairing-status')).toContainText('Ready to pair', { timeout: 10000 });

        const claim = page.locator('#pairing-status button', { hasText: 'Claim & Login' });
        await expect(claim).toBeVisible();

        // The listener must actually act. An inline onclick= would be refused
        // by the CSP and this click would do nothing at all.
        await claim.click();
        await expect(page.locator('#pairing-status')).toContainText(
            /Claiming ticket|Paired|Error/i,
            { timeout: 10000 },
        );
    });

    test('a missing ticket is reported by the external script', async ({ page }) => {
        await page.goto(`${BASE}/pair.html`);
        await expect(page.locator('#pairing-status')).toContainText(
            'No pairing ticket found',
            { timeout: 10000 },
        );
    });

    test('pair.html ships no inline handlers and loads pair.js', async ({ request }) => {
        const html = await (await request.get(`${BASE}/pair.html`)).text();
        expect(html).toContain('pair.js');
        expect(html).not.toMatch(/\son[a-z]{2,12}\s*=/i);
        // No inline <script> block (a tag without a src=).
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    });

    test('the restore button is wired when a real ticket loads the page', async ({ page }) => {
        await register(page);
        const ticket = await page.evaluate(async () => {
            const res = await fetch('/api/pairing', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + localStorage.getItem('token'),
                },
                body: JSON.stringify({
                    public_key: btoa('pub'),
                    encrypted_key_blob: btoa('blob'),
                    key_blob_nonce: btoa('nonce'),
                }),
            });
            return res.json();
        });
        await page.goto(`${BASE}/pair.html?ticket=${ticket.ticket_id}`);
        const btn = page.locator('#pairing-restore-btn');
        const hasInline = await btn.evaluate(
            (el) => el.getAttributeNames().some((a) => a.startsWith('on')),
        );
        expect(hasInline).toBe(false);
        // The password form is hidden until a claim returns a key blob, so
        // dispatch the click without actionability checks; the listener must
        // still run (a missing listener would leave the error line empty).
        await btn.dispatchEvent('click');
        await expect(page.locator('#pairing-restore-error')).toContainText('Enter your password', { timeout: 5000 });
    });
});
