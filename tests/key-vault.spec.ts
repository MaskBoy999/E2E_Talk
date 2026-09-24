// 5.6 key vault — FEATURE_PLAN.md.
//
// The vault replaces the plaintext "password bootstrap": the storage key is
// sealed with Argon2id + XChaCha20-Poly1305, and the old bootstrap is deleted
// once the vault has been proven to open (plan rule: "migration must not leave
// the old bootstrap readable alongside the new vault").
//
// The consequence is tested too, because it is the part that can lose data: a
// cold start has no key, which must show the lock screen and NEVER be confused
// with "no session" (that path redirects to login.html, which wipes the device).
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

test.describe('5.6 key vault', () => {
  test('login migrates the key into an Argon2id vault and deletes the old bootstrap', async ({ page }) => {
    await register(page, unique('vault_1'));

    // The vault exists and is a real Argon2id + AEAD container...
    const info = await page.evaluate(() => {
      const raw = (window as any)._secGetRaw('e2e_key_vault');
      const blob = raw ? JSON.parse(raw) : null;
      return { has: !!blob, blob, info: (window as any)._kvInfo() };
    });
    expect(info.has).toBe(true);
    expect(info.blob.kdf).toBe('argon2id');
    expect(info.blob.ops).toBeGreaterThan(0);
    expect(info.blob.mem).toBeGreaterThan(0);
    expect(info.blob.v).toBe(1);
    expect(typeof info.blob.c).toBe('string');

    // ...and the old bootstrap is GONE: the password is not recoverable from
    // the device any more (the plan's delete-after-migrate rule).
    const left = await page.evaluate(() => ({
      encPw: (window as any)._secGetRaw('e2e_encrypted_password'),
      fallbackKey: (window as any)._secGetRaw('e2e_local_storage_key'),
      migrated: (window as any)._secGetRaw('vault_migrated_at'),
    }));
    expect(left.encPw).toBeNull();
    expect(left.fallbackKey).toBeNull();
    expect(Number(left.migrated)).toBeGreaterThan(0);

    // The vault opens with the login password and yields the key the session is
    // actually encrypted under.
    const opened = await page.evaluate(async (pw) => {
      const r = await (window as any)._kvUnlock(pw);
      const live = (window as any)._secKeyB64();
      return { same: !!r && r.k === live, hasKey: !!r && !!r.k, user: r && r.u };
    }, PASSWORD);
    expect(opened.same).toBe(true);
    expect(opened.hasKey).toBe(true);
  });

  test('the sealed blob carries no plaintext password, key or token', async ({ page }) => {
    await register(page, unique('vault_2'));
    const r = await page.evaluate((pw) => {
      const raw = (window as any)._secGetRaw('e2e_key_vault') || '';
      const keyB64 = (window as any)._secKeyB64() || '';
      const tokenRaw = (window as any)._secGetRaw('token') || '';
      return {
        len: raw.length,
        leaksPassword: raw.includes(pw),
        leaksB64Password: raw.includes(btoa(pw)),
        leaksKey: !!keyB64 && raw.includes(keyB64),
        leaksToken: !!tokenRaw && raw.includes(tokenRaw),
      };
    }, PASSWORD);
    expect(r.len).toBeGreaterThan(0);
    expect(r.leaksPassword).toBe(false);
    expect(r.leaksB64Password).toBe(false);
    expect(r.leaksKey).toBe(false);
    expect(r.leaksToken).toBe(false);
  });

  test('a wrong password does not open the vault', async ({ page }) => {
    await register(page, unique('vault_3'));
    const r = await page.evaluate(async (pw) => {
      const bad = await (window as any)._kvUnlock(pw + '-nope');
      const empty = await (window as any)._kvUnlock('');
      const good = await (window as any)._kvUnlock(pw);
      return { bad: !!bad, empty: !!empty, good: !!good };
    }, PASSWORD);
    expect(r.bad).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.good).toBe(true);
  });

  test('migration fails closed — no vault, no deletion', async ({ page }) => {
    await register(page, unique('vault_4'));

    // Re-create a legacy bootstrap and then make the key unobtainable: the
    // migration must refuse, and the legacy blob must still be there (an
    // unrecoverable key is worse than an old bootstrap).
    const r = await page.evaluate(async (pw) => {
      const put = (k: string, v: string) => Storage.prototype.setItem.call(localStorage, k, v);
      const get = (k: string) => Storage.prototype.getItem.call(localStorage, k);
      put('e2e_encrypted_password', 'legacy-blob');
      put('vault_migrated_at', '');
      const real = (window as any)._secKeyB64;
      (window as any)._secKeyB64 = () => null;
      const ok = await (window as any)._kvMigrate(pw);
      const kept = get('e2e_encrypted_password');
      (window as any)._secKeyB64 = real;
      return { ok, kept };
    }, PASSWORD);
    expect(r.ok).toBe(false);
    expect(r.kept).toBe('legacy-blob');
  });

  // A cold start is modelled as a SECOND TAB of the same browser profile with
  // fresh sessionStorage: localStorage (the vault, the token) is shared, the
  // tab-scoped session key is not. That is exactly a desktop relaunch or an
  // Android cold start, and it is the only honest way to simulate one —
  // clearing sessionStorage on a live page is undone by the very next
  // `_ensureKey()` fast path.
  async function coldStart(page: Page): Promise<Page> {
    const fresh = await page.context().newPage();
    await fresh.goto(`${BASE}/index.html`);
    return fresh;
  }

  test('a cold start is LOCKED, not logged out: no redirect, no wipe', async ({ page }) => {
    await register(page, unique('vault_5'));
    const cold = await coldStart(page);

    // The lock screen is up...
    await cold.waitForSelector('#vault-lock-overlay', { timeout: 25000 });
    // ...the app did NOT bounce to login.html (which would have wiped the
    // device), and the session is still on disk.
    expect(new URL(cold.url()).pathname).toContain('index.html');
    const still = await cold.evaluate(() => ({
      token: (window as any)._secGetRaw('token'),
      vault: (window as any)._secGetRaw('e2e_key_vault'),
      status: (window as any)._secVaultStatus(),
    }));
    expect(still.token).not.toBeNull();
    expect(still.vault).not.toBeNull();
    expect(still.status.locked).toBe(true);
    expect(still.status.vault).toBe(true);
    expect(still.status.passwordBootstrap).toBe(false);
    // No random fallback key was minted to paper over the locked state.
    expect(await cold.evaluate(() => (window as any)._secGetRaw('e2e_local_storage_key'))).toBeNull();
    await cold.close();
  });

  test('unlocking from the lock screen restores the signed-in app', async ({ page }) => {
    const name = unique('vault_6');
    await register(page, name);
    const cold = await coldStart(page);
    await cold.waitForSelector('#vault-lock-overlay', { timeout: 25000 });

    // A wrong password stays on the lock screen and says so.
    await cold.fill('#vault-lock-password', 'definitely-not-it');
    await cold.click('#vault-lock-submit');
    await expect(cold.locator('#vault-lock-error')).toBeVisible({ timeout: 30000 });
    await expect(cold.locator('#vault-lock-overlay')).toBeVisible();

    // The real password reloads into the normal app: token readable, user
    // resolved, overlay gone.
    await cold.fill('#vault-lock-password', PASSWORD);
    await cold.click('#vault-lock-submit');
    await cold.waitForSelector('#vault-lock-overlay', { state: 'detached', timeout: 60000 });
    await cold.waitForSelector('#current-user', { timeout: 30000 });
    await expect(cold.locator('#current-user')).toHaveText(name);
    expect(new URL(cold.url()).pathname).toContain('index.html');
    await cold.close();
  });

  test('the vault is destroyed with the device, not left behind', async ({ page }) => {
    await register(page, unique('vault_7'));
    expect(await page.evaluate(() => (window as any)._kvExists())).toBe(true);
    // The one total wipe path (panic wipe) must take the vault with it: what
    // remains would otherwise be an offline-crackable blob for a stale account.
    await page.evaluate(() => (window as any).panicWipe('test'));
    await page.waitForURL(/login\.html/, { timeout: 20000 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any)._kvExists())).toBe(false);
  });
});
