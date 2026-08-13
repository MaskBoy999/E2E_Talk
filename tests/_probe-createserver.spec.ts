import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test('probe: UI register then API create-server response', async ({ page }) => {
    const ts = Date.now();
    const user1 = 'probe_' + ts;
    await page.goto(`${BASE}/login.html`);
    await page.click('#show-register');
    await page.fill('#register-username', user1);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });

    const body1 = await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
    console.log('REGISTERED user:', user1, 'token:', !!body1.token, 'id:', body1.user.id);

    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${body1.token}` },
        data: { name: 'Test Server', invite_code: 'ABCD1234' },
    });
    console.log('CREATE-SERVER status:', srv.status());
    console.log('CREATE-SERVER body:', (await srv.text()).slice(0, 300));

    // Also try with encrypted_name (the new API contract)
    const enc = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        const enc = E2ECrypto.aeadEncrypt(new TextEncoder().encode('Test Server'), key, null);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    });
    const srv2 = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${body1.token}` },
        data: { encrypted_name: enc.ciphertext, name_nonce: enc.nonce, invite_code: 'WXYZ9876' },
    });
    console.log('CREATE-SERVER-ENCRYPTED status:', srv2.status());
    console.log('CREATE-SERVER-ENCRYPTED body:', (await srv2.text()).slice(0, 300));
    expect(true).toBe(true);
});
