import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('saveKeyBlobToServer console.error logging', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
    }

    function collectConsoleErrors(page: any): { messages: string[]; start: () => void; stop: () => void } {
        const messages: string[] = [];
        let handler: ((msg: any) => void) | null = null;
        return {
            messages,
            start() {
                handler = (msg: any) => {
                    if (msg.type() === 'error') {
                        messages.push(msg.text());
                    }
                };
                page.on('console', handler);
            },
            stop() {
                if (handler) {
                    page.off('console', handler);
                    handler = null;
                }
            },
        };
    }

    // ─────────────────────────────────────────────────────────────────
    // Path 1: missing e2e_encrypted_password or e2e_device_key
    // ─────────────────────────────────────────────────────────────────
    test('Path 1: missing encrypted_password logs "missing"', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'p1_' + ts);

        const collector = collectConsoleErrors(page);
        collector.start();
        try {
            await page.evaluate(() => {
                localStorage.removeItem('e2e_encrypted_password');
                saveKeyBlobToServer();
            });
        } finally {
            collector.stop();
        }
        console.log('Path 1 console errors:', collector.messages);
        const found = collector.messages.some(m =>
            m.includes('missing e2e_encrypted_password or e2e_device_key')
        );
        expect(found).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────
    // Path 2: decodeEncryptedFileKey returns null
    // Set e2e_encrypted_password to an invalid value so decode fails.
    // ─────────────────────────────────────────────────────────────────
    test('Path 2: corrupted encrypted_password logs "failed to decode"', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'p2_' + ts);

        const collector = collectConsoleErrors(page);
        collector.start();
        try {
            await page.evaluate(() => {
                localStorage.setItem('e2e_encrypted_password',
                    'AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
                saveKeyBlobToServer();
            });
        } finally {
            collector.stop();
        }
        console.log('Path 2 console errors:', collector.messages);
        const found = collector.messages.some(m =>
            m.includes('failed to decode password from e2e_encrypted_password')
        );
        expect(found).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────
    // Path 3: no auth token
    // ─────────────────────────────────────────────────────────────────
    test('Path 3: missing token logs "no auth token"', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'p3_' + ts);

        const collector = collectConsoleErrors(page);
        collector.start();
        try {
            await page.evaluate(() => {
                localStorage.removeItem('token');
                saveKeyBlobToServer();
            });
        } finally {
            collector.stop();
        }
        console.log('Path 3 console errors:', collector.messages);
        const found = collector.messages.some(m =>
            m.includes('no auth token available')
        );
        expect(found).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────
    // Path 4: HTTP PUT fails (network error)
    // Override fetch to reject for /api/key-blob requests.
    // ─────────────────────────────────────────────────────────────────
    test('Path 4: network failure logs "HTTP PUT failed" with error detail', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'p4_' + ts);

        const collector = collectConsoleErrors(page);
        collector.start();
        try {
            await page.evaluate(() => {
                const origFetch = window.fetch.bind(window);
                window.fetch = function(url, opts) {
                    var urlStr = typeof url === 'string' ? url : url.url;
                    if (urlStr && urlStr.indexOf('/api/key-blob') !== -1) {
                        return Promise.reject(new Error('Simulated network failure'));
                    }
                    return origFetch(url, opts);
                };
                saveKeyBlobToServer();
            });
            // Wait for the async fetch rejection to be handled by .catch()
            await page.waitForTimeout(500);
        } finally {
            collector.stop();
        }
        console.log('Path 4 console errors:', collector.messages);
        const found = collector.messages.some(m =>
            m.includes('HTTP PUT failed') && m.includes('Simulated network failure')
        );
        expect(found).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────
    // Path 5: unexpected error in try block
    // Make buildKeyBundle throw to trigger the outer catch.
    // ─────────────────────────────────────────────────────────────────
    test('Path 5: unexpected error logs "unexpected error" with details', async ({ page }) => {
        const ts = Date.now();
        await registerUser(page, 'p5_' + ts);

        const collector = collectConsoleErrors(page);
        collector.start();
        try {
            await page.evaluate(() => {
                var origBuild = E2ECrypto.buildKeyBundle;
                E2ECrypto.buildKeyBundle = function() {
                    throw new Error('deliberate buildKeyBundle failure');
                };
                saveKeyBlobToServer();
                E2ECrypto.buildKeyBundle = origBuild;
            });
        } finally {
            collector.stop();
        }
        console.log('Path 5 console errors:', collector.messages);
        const found = collector.messages.some(m =>
            m.includes('unexpected error') && m.includes('deliberate buildKeyBundle failure')
        );
        expect(found).toBe(true);
    });
});
