import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

test('PROBE2: bootstrap material that a localStorage scrape would get', async ({ browser }) => {
    test.setTimeout(180000);
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await register(page, unique('probe2'));

    const out = await page.evaluate(() => {
        const keys: any[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) as string;
            const raw = (window as any)._secGetRaw(k) || '';
            keys.push({ k, enc: raw.charAt(0) === '~', len: raw.length });
        }
        // Can an attacker who only has the LOCALSTORAGE DUMP derive the key?
        // e2e_device_key + e2e_encrypted_password are plaintext bootstrap.
        const devKey = (window as any)._secGetRaw('e2e_device_key');
        const encPw = (window as any)._secGetRaw('e2e_encrypted_password');
        return {
            keys,
            localKeyPresent: keys.some((x) => x.k === 'e2e_local_storage_key'),
            sessionKeyPresent: !!sessionStorage.getItem('_ssk'),
            deviceKeyPlaintext: !!devKey,
            encPasswordPlaintext: !!encPw,
            // Simulate the scrape-then-decrypt attack with only the dump:
            // device key decrypts the password, password derives the storage key.
            passwordRecoverable: (() => {
                try {
                    const E = (window as any).E2ECrypto;
                    const dev = new Uint8Array(E.base64ToArrayBuffer(devKey));
                    const pw = E.decodeEncryptedFileKey(encPw, dev);
                    return typeof pw === 'string' && pw.length > 0;
                } catch (_) { return false; }
            })(),
        };
    });

    console.log('=== PROBE2 ===');
    console.log(JSON.stringify(out, null, 2));
    expect(out.deviceKeyPlaintext).toBeTruthy();
    await ctx.close();
});
