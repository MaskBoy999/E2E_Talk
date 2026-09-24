// 5.1 biometric unlock (FEATURE_PLAN.md) — the JS half of the Keystore work.
//
// The prompt and the AES-GCM sealing happen in Kotlin (asserted textually at
// the bottom); what is exercised here is the contract around them:
//   * enable wraps the REAL storage password and stores only the ciphertext;
//   * a failed/cancelled prompt leaves the toggle off and nothing sealed;
//   * the login page offers "Unlock with fingerprint" only on the Android box
//     with a seal present, and completing the prompt logs in for real;
//   * the password path is never taken away.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
  return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

/** Install an Android box whose bridge answers biometricSeal the way Kotlin would. */
async function mockAndroidBridge(page: Page, opts: { failPrompt?: boolean } = {}) {
  await page.addInitScript((fail: boolean) => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
      configurable: true,
    });
    (window as any).__bridgeCalls = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args: any) => {
          (window as any).__bridgeCalls.push([cmd, args]);
          if (cmd === 'plugin:box-shell|biometricAvailable') return { available: true };
          if (cmd === 'plugin:box-shell|biometricSeal') {
            if (fail) throw new Error('biometric: canceled');
            if (args.mode === 'wrap') return { data: 'SEALED:' + args.data };
            // unwrap: hand back the sealed payload, i.e. the real password bytes.
            const wrapped = String(args.data).replace(/^SEALED:/, '');
            return { data: wrapped };
          }
          return null;
        },
      },
    };
  }, !!opts.failPrompt);
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

test.describe('5.1 biometric unlock', () => {
  test('the group exists and is honestly disabled off the Android box', async ({ page }) => {
    await register(page, unique('bio_desktop'));
    await expect(page.locator('#biometric-unlock-toggle')).toHaveCount(1);
    const st = await page.evaluate(() => (window as any).__biometric.status());
    expect(st.available).toBe(false);
    expect(st.reason).toBe('not-android');
    // ...and the enable path refuses rather than pretending.
    const err = await page.evaluate(async () => {
      try { await (window as any).__biometric.enable(); return null; }
      catch (e) { return String(e && e.message); }
    });
    expect(err).toContain('Android');
    await expect(page.locator('#biometric-status-line')).toContainText('Android');
  });

  test('enabling seals the real password — never the plaintext', async ({ page }) => {
    await mockAndroidBridge(page);
    await register(page, unique('bio_enable'));

    const wrap = await page.evaluate(() => {
      const before = (window as any).__bridgeCalls.length;
      return (window as any).__biometric.enable().then(() => {
        const call = (window as any).__bridgeCalls.slice(before).find((c: any[]) => c[0].endsWith('biometricSeal'));
        const payload = call ? call[1].data : null;
        // Decode the base64 payload the way the Kotlin side does.
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
        return {
          mode: call ? call[1].mode : null,
          decoded,
          seal: localStorage.getItem('e2e_bio_seal'),
          user: localStorage.getItem('e2e_bio_user'),
        };
      });
    });
    expect(wrap.mode).toBe('wrap');
    // The sealed payload IS the real password...
    expect(wrap.decoded).toBe(PASSWORD);
    // ...and what we keep on disk is the bridge's ciphertext, not the password.
    expect(wrap.seal).toMatch(/^SEALED:/);
    expect(wrap.seal).not.toContain(PASSWORD);
    expect(wrap.user).toContain('bio_enable');

    // Toggle reflects reality, and disabling drops every copy we kept.
    const after = await page.evaluate(async () => {
      const st = await (window as any).__biometric.status();
      await (window as any).__biometric.disable();
      return { enabled: st.enabled, seal: localStorage.getItem('e2e_bio_seal'), user: localStorage.getItem('e2e_bio_user') };
    });
    expect(after.enabled).toBe(true);
    expect(after.seal).toBeNull();
    expect(after.user).toBeNull();
  });

  test('a cancelled prompt seals nothing and never looks enabled', async ({ page }) => {
    await mockAndroidBridge(page, { failPrompt: true });
    await register(page, unique('bio_cancel'));

    // The settings toggle is what a user actually clicks.
    const res = await page.evaluate(async () => {
      const box = document.getElementById('biometric-unlock-toggle') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      return {
        checked: box.checked,
        seal: localStorage.getItem('e2e_bio_seal'),
        status: document.getElementById('biometric-status-line')!.textContent,
      };
    });
    expect(res.checked).toBe(false);          // put back
    expect(res.seal).toBeNull();              // nothing sealed
    expect(res.status).toContain('cancel');   // and the reason is visible

    const st = await page.evaluate(() => (window as any).__biometric.status());
    expect(st.enabled).toBe(false);
  });

  test('the login page unlocks with a fingerprint and signs in for real', async ({ page }) => {
    await mockAndroidBridge(page);
    const username = unique('bio_login');
    await register(page, username);

    // Enable biometric for this account, then land on the login page the way a
    // user does after signing out — seal present, no session.
    await page.evaluate(() => (window as any).__biometric.enable());
    await page.evaluate(() => { localStorage.removeItem('token'); localStorage.removeItem('user'); });
    await page.goto(`${BASE}/login.html`);

    const btn = page.locator('#biometric-unlock-btn');
    await expect(btn).toBeVisible(); // it appears BEFORE any typing

    await btn.click();
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
    expect(await page.evaluate(() => document.getElementById('current-user')!.textContent)).toBe(username);
  });

  test('without a seal there is no fingerprint button at all', async ({ page }) => {
    await mockAndroidBridge(page);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.removeItem('e2e_bio_seal'));
    await page.reload();
    await expect(page.locator('#biometric-unlock-btn')).toBeHidden();
    // ...and the password path is right there.
    await expect(page.locator('#login-password')).toBeVisible();
  });

  test('the Kotlin half keeps the strong guarantees', () => {
    const home = process.cwd();
    const kt = readFileSync(
      home + '/src-tauri/plugins/box-shell/android/src/main/java/com/e2echat/boxshell/BoxShellPlugin.kt', 'utf8');
    // Per-operation, biometric-strength-only key.
    expect(kt).toContain('AUTH_BIOMETRIC_STRONG');
    expect(kt).toContain('setUserAuthenticationRequired(true)');
    expect(kt).toMatch(/setUserAuthenticationParameters\(0,/);
    // The ciphertext only exists after a successful match...
    expect(kt).toContain('onAuthenticationSucceeded');
    // ...and a failure rejects instead of resolving anything.
    expect(kt).toMatch(/onAuthenticationError[\s\S]{0,600}invoke\.reject/);
    // Never log the payload.
    expect(kt).not.toMatch(/Log\.[a-z]\([^)]*(payload|data|args\.data)/);
    // The commands are declared (and therefore granted) in the plugin manifest.
    const buildRs = readFileSync(home + '/src-tauri/plugins/box-shell/build.rs', 'utf8');
    expect(buildRs).toContain('biometricAvailable');
    expect(buildRs).toContain('biometricSeal');
  });
});
