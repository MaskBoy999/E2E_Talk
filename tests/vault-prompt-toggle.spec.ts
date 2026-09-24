// 5.6 key vault — the "ask for my password after a restart" OPTION.
//
// The vault seals the storage key under the password; what used to be
// unavoidable (a cold start always stopped at "Unlock your key vault") is now a
// Security setting. Flipping it is NOT a flag write: the password is typed into
// a modal, checked against this device's vault, and everything stored on the
// device is re-encrypted with the key that password releases — the store can
// never end up under a key the vault does not hold. These tests pin:
//
//   * ON (default): a cold start is LOCKED, the lock screen is not the login
//     page, and `loadDecryptedPassword()` is null while locked.
//   * OFF: after the password is checked, the device keeps the key, a cold
//     start opens straight into the app — and it is the SAME app (socket up,
//     token readable, password-dependent flows still fed).
//   * a wrong password, a cancel, or a missing password changes NOTHING.
//   * the preference survives a sign-out; the key copy does not.
//
// A "cold start" is a SECOND TAB of the same browser profile with fresh
// sessionStorage (shared localStorage, tab-scoped session key) — the only
// honest simulation of a relaunch.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
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

async function coldStart(page: Page): Promise<Page> {
    const fresh = await page.context().newPage();
    await fresh.goto(`${BASE}/index.html`);
    return fresh;
}

async function openSecurityTab(page: Page) {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 10000 });
    await page.click('.settings-tab[data-tab="security-settings"]');
    // The switch INPUT is deliberately display:none (the slider is the visible
    // control), so wait on the group's status line instead.
    await page.waitForSelector('#vault-prompt-status', { state: 'visible', timeout: 10000 });
}

/** Flip the switch, type `password`, press Confirm — the user's own path. */
async function flipVault(page: Page, wantOn: boolean, password: string) {
    return page.evaluate(async ({ wantOn, password }) => {
        const t = document.getElementById('vault-ask-password-toggle') as HTMLInputElement;
        t.checked = wantOn;
        t.dispatchEvent(new Event('change', { bubbles: true }));
        const modalOpen = !!(window as any).__vaultPromptModal.isOpen();
        const pending = (window as any).__vaultPromptModal.pending();
        const inp = document.getElementById('vault-pw-input') as HTMLInputElement;
        inp.value = password;
        await (window as any).__vaultPromptModal.confirm();
        return {
            modalOpen,
            pending,
            stillOpen: (window as any).__vaultPromptModal.isOpen(),
            error: (document.getElementById('vault-pw-error') as HTMLElement).textContent || '',
            status: (window as any)._secVaultStatus(),
            checked: t.checked,
        };
    }, { wantOn, password });
}

test.describe('key vault: "ask for my password after a restart" (5.6 option)', () => {
    test('the setting exists, is on by default, and reports this device honestly', async ({ page }) => {
        await register(page, unique('vaultopt1'));

        const st = await page.evaluate(() => (window as any)._secVaultStatus());
        // The shape the manual checklist reads out.
        expect(st.locked).toBe(false);
        expect(st.vault).toBe(true);
        expect(st.passwordBootstrap).toBe(false);
        expect(st.hasKey).toBe(true);
        // …plus the two new fields this setting adds.
        expect(st.asksPassword).toBe(true);
        expect(st.keyOnDevice).toBe(false);

        await openSecurityTab(page);
        const ui = await page.evaluate(() => {
            const t = document.getElementById('vault-ask-password-toggle') as HTMLInputElement;
            return {
                checked: t.checked,
                disabled: t.disabled,
                status: (document.getElementById('vault-prompt-status') as HTMLElement).textContent || '',
            };
        });
        expect(ui.checked).toBe(true);
        expect(ui.disabled).toBe(false);
        expect(ui.status).toContain('your password is required after a restart');
    });

    test('with it on: a cold start is locked, the password is not readable, and a wrong one changes nothing', async ({ page }) => {
        await register(page, unique('vaultopt2'));
        const cold = await coldStart(page);

        await cold.waitForSelector('#vault-lock-overlay', { timeout: 25000 });
        expect(new URL(cold.url()).pathname).toContain('index.html');

        // Break test: the lock must be real. If this returns the password, the
        // "locked" state is theatre.
        expect(await cold.evaluate(() => {
            const fn = (window as any).loadDecryptedPassword;
            return typeof fn === 'function' ? fn() : null;
        })).toBeNull();

        // A wrong password stays locked, says so, and leaves storage untouched.
        await cold.fill('#vault-lock-password', 'definitely-not-it');
        await cold.click('#vault-lock-submit');
        await expect(cold.locator('#vault-lock-error')).toBeVisible({ timeout: 30000 });
        await expect(cold.locator('#vault-lock-overlay')).toBeVisible();
        expect(await cold.evaluate(() => (window as any)._secVaultStatus().locked)).toBe(true);
        expect(await cold.evaluate(() => (window as any)._secGetRaw('e2e_local_storage_key'))).toBeNull();

        // The real password brings the app back, not a fresh login.
        await cold.fill('#vault-lock-password', PASSWORD);
        await cold.click('#vault-lock-submit');
        await cold.waitForSelector('#vault-lock-overlay', { state: 'detached', timeout: 60000 });
        await cold.waitForSelector('#current-user', { timeout: 30000 });
        expect(await cold.evaluate(() => (window as any)._secVaultStatus().locked)).toBe(false);
        await cold.close();
    });

    test('the switch asks for the password, and a wrong one (or a cancel) changes nothing', async ({ page }) => {
        await register(page, unique('vaultopt3'));
        await openSecurityTab(page);

        // Cancelling the modal puts the switch back where it was.
        const cancelled = await page.evaluate(() => {
            const t = document.getElementById('vault-ask-password-toggle') as HTMLInputElement;
            t.checked = false;
            t.dispatchEvent(new Event('change', { bubbles: true }));
            const opened = (window as any).__vaultPromptModal.isOpen();
            (window as any).__vaultPromptModal.close();
            return {
                opened,
                stillOpen: (window as any).__vaultPromptModal.isOpen(),
                asks: (window as any)._secVaultStatus().asksPassword,
                keyOnDevice: (window as any)._secVaultStatus().keyOnDevice,
            };
        });
        expect(cancelled.opened).toBe(true);
        expect(cancelled.stillOpen).toBe(false);
        expect(cancelled.asks).toBe(true);
        expect(cancelled.keyOnDevice).toBe(false);

        // A wrong password is rejected: the modal stays up, the setting and the
        // device's storage are untouched.
        const wrong = await flipVault(page, false, 'definitely-not-it');
        expect(wrong.modalOpen).toBe(true);
        expect(wrong.pending).toBe('off');
        expect(wrong.stillOpen).toBe(true);
        expect(wrong.error).toContain('does not open this device');
        expect(wrong.status.asksPassword).toBe(true);
        expect(wrong.status.keyOnDevice).toBe(false);
        await page.evaluate(() => (window as any).__vaultPromptModal.close());

        // And an empty one does not even try.
        const empty = await flipVault(page, false, '');
        expect(empty.error).toContain('Enter your password');
        expect(empty.status.asksPassword).toBe(true);
        await page.evaluate(() => (window as any).__vaultPromptModal.close());
    });

    test('turning it off checks the password, keeps the key, and a cold start opens straight in', async ({ page }) => {
        await register(page, unique('vaultopt4'));
        await openSecurityTab(page);

        const off = await flipVault(page, false, PASSWORD);
        expect(off.modalOpen).toBe(true);
        expect(off.stillOpen).toBe(false);
        expect(off.error).toBe('');
        expect(off.status.asksPassword).toBe(false);
        expect(off.status.keyOnDevice).toBe(true);
        expect(await page.evaluate(() => Storage.prototype.getItem.call(localStorage, 'e2e_local_storage_key') !== null)).toBe(true);
        // The store is settled on the key the vault holds for that password —
        // this is the "everything is encrypted with what I typed" guarantee.
        const settled = await page.evaluate(async (pw) => {
            const opened = await (window as any)._kvUnlock(pw);
            // localStorage.getItem goes through the interceptor, so this is the
            // app's own read: a token here means the re-key did not orphan data.
            return { same: !!opened && opened.k === (window as any)._secKeyB64(), token: localStorage.getItem('token') };
        }, PASSWORD);
        expect(settled.same).toBe(true);
        expect(settled.token).toBeTruthy();

        // The cold start now finds that key: no lock screen, and the SAME app —
        // socket up, token readable, username resolved, and the flows that want
        // the password itself still fed (from the vault ticket, not from typing).
        const cold = await coldStart(page);
        await cold.waitForSelector('#current-user', { timeout: 30000 });
        expect(await cold.locator('#vault-lock-overlay').count()).toBe(0);
        await cold.waitForFunction(() => {
            const w = window as any;
            return !!(w.ws && w.ws.readyState === 1);
        }, { timeout: 30000 });
        const usual = await cold.evaluate(() => {
            const w = window as any;
            return {
                user: (document.getElementById('current-user') as HTMLElement).textContent || '',
                token: localStorage.getItem('token'),
                password: w.loadDecryptedPassword ? w.loadDecryptedPassword() : null,
                unlockedFlag: w._secLocked === false,
            };
        });
        expect(usual.user.length).toBeGreaterThan(0);
        expect(usual.token).toBeTruthy();
        expect(usual.unlockedFlag).toBe(true);
        expect(usual.password).toBe(PASSWORD);
        // The vault itself is untouched — this was about WHERE the key lives.
        expect(await cold.evaluate(() => (window as any)._kvExists())).toBe(true);
        expect(await cold.evaluate(() => (window as any)._secGetRaw('e2e_key_vault'))).not.toBeNull();
        await cold.close();

        // Turning it back on also asks for the password, deletes the copy, and
        // brings the lock screen back.
        const wrongOn = await flipVault(page, true, 'nope-not-it');
        expect(wrongOn.stillOpen).toBe(true);
        expect(wrongOn.status.asksPassword).toBe(false);
        await page.evaluate(() => (window as any).__vaultPromptModal.close());

        const on = await flipVault(page, true, PASSWORD);
        expect(on.stillOpen).toBe(false);
        expect(on.status.asksPassword).toBe(true);
        expect(on.status.keyOnDevice).toBe(false);
        expect(await page.evaluate(() => Storage.prototype.getItem.call(localStorage, 'e2e_local_storage_key'))).toBeNull();

        const cold2 = await coldStart(page);
        await cold2.waitForSelector('#vault-lock-overlay', { timeout: 25000 });
        expect(await cold2.evaluate(() => (window as any)._secGetRaw('e2e_local_storage_key'))).toBeNull();
        // …and the password still opens it, with the app intact behind it.
        await cold2.fill('#vault-lock-password', PASSWORD);
        await cold2.click('#vault-lock-submit');
        await cold2.waitForSelector('#vault-lock-overlay', { state: 'detached', timeout: 60000 });
        expect(await cold2.evaluate(() => localStorage.getItem('token'))).toBeTruthy();
        await cold2.close();
    });

    test('the preference follows you across a sign-out, and the key copy does not', async ({ page }) => {
        await register(page, unique('vaultopt5'));

        const off = await page.evaluate(async (pw) => {
            const r = await (window as any)._secVaultDropRequirement(pw);
            return { r, keyOnDevice: (window as any)._secVaultStatus().keyOnDevice };
        }, PASSWORD);
        expect(off.r.ok).toBe(true);
        expect(off.keyOnDevice).toBe(true);

        // Sign out for real: with no session token the login page is what you
        // get (holding one, it would just bounce back into the app) and it runs
        // its wipe. The flag must survive that; the key copy must not — it is
        // e2e_-prefixed, so the wipe takes it.
        await page.evaluate(() => {
            Storage.prototype.removeItem.call(localStorage, 'token');
            Storage.prototype.removeItem.call(localStorage, 'user');
        });
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 20000 });
        const after = await page.evaluate(() => ({
            flag: Storage.prototype.getItem.call(localStorage, 'vaultAskPassword'),
            copy: Storage.prototype.getItem.call(localStorage, 'e2e_local_storage_key'),
        }));
        expect(after.flag).toBe('0');
        expect(after.copy).toBeNull();
    });
});
