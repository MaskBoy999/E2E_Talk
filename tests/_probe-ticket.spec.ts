import { test, expect } from '@playwright/test';
const BASE = 'https://localhost:3443';

test('ticket state after register', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', 'tkt_' + Date.now());
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#current-user', { timeout: 15000 });

    const st = await page.evaluate(() => {
        const W = window as any;
        const raw = (k: string) => W._secGetRaw ? W._secGetRaw(k) : localStorage.getItem(k);
        return {
            ticketRaw: raw('e2e_vault_ticket'),
            ticketRead: W._kvTicketRead ? W._kvTicketRead() : 'NO_FN',
            secGet: W._secGet ? W._secGet('e2e_vault_ticket') : 'NO_FN',
            keyB64: W._secKeyB64(),
            mem: W._vaultSessionPassword || null,
            ldp: (typeof W.loadDecryptedPassword === 'function') ? W.loadDecryptedPassword() : 'NO_FN',
            vault: raw('e2e_key_vault') ? 'present' : null,
            encPw: raw('e2e_encrypted_password'),
            migrated: raw('vault_migrated_at'),
            locked: !!W._secLocked,
            status: W._secVaultStatus ? W._secVaultStatus() : null,
        };
    });
    console.log('PROBE_RESULT ' + JSON.stringify(st, null, 1));
    expect(true).toBe(true);
});
