import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test('capture console errors from page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
        if (msg.type() === 'error') {
            errors.push(msg.text());
        }
    });
    page.on('pageerror', err => errors.push('PAGE: ' + err.message));

    await page.goto(`${BASE}/test-secure-minimal.html`, { waitUntil: 'networkidle' });

    // Check status from the page itself - did the last script run?
    const status = await page.evaluate(() => {
        return {
            statusText: document.getElementById('status')?.textContent,
            ssk: sessionStorage.getItem('_ssk'),
            initReturnValue: (window as any)._secInit(),
            sskAfterRetry: sessionStorage.getItem('_ssk'),
        };
    });

    console.log('CONSOLE ERRORS:', JSON.stringify(errors));
    console.log('STATUS:', JSON.stringify(status));
});
