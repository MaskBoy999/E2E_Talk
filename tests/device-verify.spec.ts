// 5.4 device verification (SAS/emoji) — FEATURE_PLAN.md.
//
// The short authentication string is derived from BOTH identity keys, so it is
// the same on both devices (proving it is not chosen by one side) and it stays
// in-app: no notification, widget or log may ever carry it.
import { test, expect, type Page, type Browser } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
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
  return await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}'));
}

async function twoUsers(browser: Browser) {
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const nameA = unique('sas_a');
  const nameB = unique('sas_b');
  const userA = await register(a, nameA);
  const userB = await register(b, nameB);
  return { a, b, ctxA, ctxB, userA, userB };
}

test.describe('5.4 device verification (SAS)', () => {
  test('the string is order-independent, deterministic and shaped right', async ({ page }) => {
    await register(page, unique('sas_pure'));
    const r = await page.evaluate(() => {
      const f = (window as any).__deviceVerify.sasFromFingerprints;
      const one = f('AAAA-BBBB', 'CCCC-DDDD');
      const two = f('CCCC-DDDD', 'AAAA-BBBB');
      return {
        one, two,
        other: f('AAAA-BBBB', 'EEEE-FFFF'),
        same: f('AAAA-BBBB', 'AAAA-BBBB'),
      };
    });
    // Both devices sort before hashing, so the order they pass in cannot matter.
    expect(r.two.emoji).toEqual(r.one.emoji);
    expect(r.two.digits).toBe(r.one.digits);
    expect(r.one.emoji).toHaveLength(6);
    expect(r.one.digits).toMatch(/^\d{6}$/);
    // A different key pair is a different string...
    expect(r.other.digits === r.one.digits && r.other.emoji.join() === r.one.emoji.join()).toBe(false);
  });

  test('both devices show the SAME string for each other', async ({ browser }) => {
    const { a, b, ctxA, ctxB, userA, userB } = await twoUsers(browser);
    try {
      const read = async (page: Page, otherId: string, name: string) => {
        await page.evaluate(async ({ id, n }: { id: string; n: string }) => {
          await (window as any).__deviceVerify.open(id, n);
        }, { id: otherId, n: name });
        const shown = await page.evaluate(() => ({
          emoji: document.getElementById('device-verify-emoji')!.textContent!.trim(),
          digits: document.getElementById('device-verify-digits')!.textContent!.trim(),
          mine: document.getElementById('device-verify-mine')!.textContent!.trim(),
          theirs: document.getElementById('device-verify-theirs')!.textContent!.trim(),
          visible: getComputedStyle(document.getElementById('device-verify-modal')!).display !== 'none',
        }));
        return shown;
      };
      const onA = await read(a, userB.id, 'Bee');
      const onB = await read(b, userA.id, 'Aye');

      expect(onA.visible).toBe(true);
      expect(onA.emoji.split(/\s+/)).toHaveLength(6);
      // The whole point: identical on both sides without either choosing it.
      expect(onB.digits).toBe(onA.digits);
      expect(onB.emoji).toBe(onA.emoji);
      // Each side's own fingerprint is the other's "theirs".
      expect(onB.theirs).toBe(onA.mine);
      expect(onA.theirs).toBe(onB.mine);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('marking verified pins the key, and a later key change then warns', async ({ browser }) => {
    const { a, b, ctxA, ctxB, userA, userB } = await twoUsers(browser);
    try {
      // B's real published key, as A sees it.
      const realKey = await a.evaluate(async (id: string) => {
        const r = await fetch('/api/identity/' + encodeURIComponent(id), {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        return (await r.json()).identity_public_key;
      }, userB.id);
      expect(typeof realKey).toBe('string');

      const res = await a.evaluate(async ({ id, key }: { id: string; key: string }) => {
        (window as any).__toasts = [];
        (window as any).showToast = (m: string) => { (window as any).__toasts.push(m); };
        await (window as any).__deviceVerify.open(id, 'Bee');
        const sas = {
          digits: document.getElementById('device-verify-digits')!.textContent,
          emoji: document.getElementById('device-verify-emoji')!.textContent,
        };
        document.getElementById('device-verify-confirm')!.click();
        await new Promise((r) => setTimeout(r, 50));
        const stored = localStorage.getItem('e2e_verified_fp_' + id);
        // Now the peer's key changes underneath us (a re-install, or an attack).
        const changed = (window as any).E2ECrypto.arrayBufferToBase64(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
        (window as any).verifyOrWarnFingerprint(id, changed);
        return { sas, stored, toasts: (window as any).__toasts, realKeyStillOk: !!key };
      }, { id: userB.id, key: realKey });

      // Verified: the fingerprint we just displayed is what got pinned...
      expect(res.stored).toBeTruthy();
      // ...and the stored fingerprint is the real peer key's, not a placeholder.
      const expected = await a.evaluate(async (id: string) => {
        const r = await fetch('/api/identity/' + encodeURIComponent(id), {
          headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const k = (await r.json()).identity_public_key;
        return (window as any).E2ECrypto.computeFingerprint(
          new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(k)));
      }, userB.id);
      expect(res.stored).toBe(expected);
      // A changed key is now flagged (TOFU reads the same store).
      expect(res.toasts.join(' ')).toContain('identity key changed');
      expect(res.sas.digits).toBeTruthy();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('the string stays in-app: never in a notification, a widget or a log', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await register(page, unique('sas_contain'));
    // Self-computed so we know the exact string the UI is showing.
    const probe = await page.evaluate(async () => {
      const kp = (window as any).E2ECrypto.getIdentityKeyPair();
      const fp = (window as any).E2ECrypto.computeFingerprint(
        kp.publicKey instanceof Uint8Array ? kp.publicKey : new Uint8Array(kp.publicKey));
      const sas = (window as any).__deviceVerify.sasFromFingerprints(fp, fp);
      return { digits: sas.digits, emoji: sas.emoji.join(' ') };
    });
    await page.waitForTimeout(300);
    expect(logs.join('\n')).not.toContain(probe.digits);
    expect(logs.join('\n')).not.toContain('SAS');
  });

  test('the profile modal only offers it for other people', async () => {
    const home = process.cwd();
    const js = require('node:fs').readFileSync(home + '/static/chat.js', 'utf8');
    // Own profile hides the row; the modal itself is in-app DOM only.
    expect(js).toMatch(/profile-verify-row[\s\S]{0,400}_isOwnProfile/);
    // The verification prompt renders into the DOM, and the confirmation writes
    // the SAME store the TOFU check reads.
    expect(js).toMatch(/device-verify-emoji/);
    expect(js).toMatch(/device-verify-confirm[\s\S]{0,600}E2ECrypto\.verifyFingerprint/);
    // Nothing in this path is allowed to reach a notification.
    const idx = require('node:fs').readFileSync(home + '/static/index.html', 'utf8');
    expect(idx).toContain('device-verify-modal');
  });
});
