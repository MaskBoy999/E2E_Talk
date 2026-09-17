import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PW = 'testpass123';

async function register(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
}

test.describe('Vault file list sizes', () => {
    test('each file shows its uncompressed size AND the compressed size counted against the limit', async ({ page }) => {
        test.setTimeout(90000);
        await register(page, 'vaultsize_' + Date.now());

        await page.route('**/api/vault/files', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    files: [
                        {
                            id: 'f-compressed',
                            encrypted_filename: '', filename_nonce: '',
                            encrypted_mime_type: '', mime_type_nonce: '',
                            encrypted_file_key: '', file_key_nonce: '',
                            content_hash: '', compression: 'gzip',
                            original_size: 1572864,   // 1.5 MB uncompressed
                            stored_size: 430080,      // 420 KB compressed (what the quota counts)
                            created_at: '2026-09-01 10:00:00',
                        },
                        {
                            id: 'f-incompressible',
                            encrypted_filename: '', filename_nonce: '',
                            encrypted_mime_type: '', mime_type_nonce: '',
                            encrypted_file_key: '', file_key_nonce: '',
                            content_hash: '', compression: 'none',
                            original_size: 2048,
                            stored_size: 2048,
                            created_at: '2026-09-02 10:00:00',
                        },
                    ],
                    total_size: 432128,
                    max_size_bytes: 1073741824,
                }),
            });
        });

        await page.click('#vault-btn');
        await page.waitForSelector('#vault-file-list .vault-file-item', { timeout: 15000 });

        const metas = await page.evaluate(() => Array.from(
            document.querySelectorAll('#vault-file-list .vault-file-item')
        ).map((item) => {
            const meta = item.querySelector('.vault-file-meta') as HTMLElement;
            const stored = item.querySelector('.vault-size-stored') as HTMLElement;
            return {
                text: meta ? (meta.textContent || '').replace(/\s+/g, ' ').trim() : '',
                storedTitle: stored ? (stored.getAttribute('title') || '') : null,
            };
        }));

        expect(metas.length).toBe(2);
        // Compressed file: uncompressed size first, then the stored size
        expect(metas[0].text).toContain('1.5 MB');
        expect(metas[0].text).toContain('420.0 KB stored');
        expect(metas[0].storedTitle).toContain('vault limit');
        // Incompressible file: one size only (no redundant "stored" label)
        expect(metas[1].text).toContain('2.0 KB');
        expect(metas[1].text).not.toContain('stored');
        expect(metas[1].storedTitle).toBeNull();
    });
});
