import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://localhost:3443';

test.describe('G1 — Security headers on all responses', () => {
  test('static pages and API responses carry CSP/nosniff/X-Frame/Referrer/HSTS', async ({ request }) => {
    for (const url of ['/login.html', '/api/me']) {
      const res = await request.get(BASE + url);
      // 401/200 both count — we only care about headers being present.
      expect(res.status() < 500, `${url} returned ${res.status()}`).toBe(true);
      const headers = res.headers();
      expect(headers['content-security-policy'] || headers['content-security-policy'],
        `${url} must have CSP`).toBeTruthy();
      expect(headers['x-content-type-options'], `${url} nosniff`).toBe('nosniff');
      expect(headers['x-frame-options'], `${url} X-Frame-Options`).toBe('DENY');
      expect(headers['referrer-policy'], `${url} Referrer-Policy`).toBe('no-referrer');
      // HTTPS test server → HSTS must be present.
      expect(headers['strict-transport-security'], `${url} HSTS`).toContain('max-age=31536000');
    }
  });
});

test.describe('G3 — Origin check on state-changing endpoints', () => {
  let token: string;
  let username: string;

  test.beforeAll(async () => {
    // Use a page to register (the login flow sets localStorage + token).
    // eslint-disable-next-line no-undef
  });

  test('forged Origin on POST is rejected with 403; same-origin works', async ({ page }) => {
    const uname = 'origin_' + Date.now();
    await page.goto(BASE + '/login.html');
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', uname);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();

    // Forged Origin → 403 (mutation endpoints are Origin-checked).
    const forged = await page.request.post(`${BASE}/api/friend-code/regenerate`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://evil.example.com',
      },
    });
    expect(forged.status(), 'forged origin blocked').toBe(403);

    // Same-origin (correct Host) → allowed (200 or 429 only under extreme load).
    const same = await page.request.post(`${BASE}/api/friend-code/regenerate`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: BASE,
      },
    });
    expect([200, 429]).toContain(same.status());

    // No Origin at all (non-browser client) → allowed.
    const none = await page.request.post(`${BASE}/api/friend-code/regenerate`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 429]).toContain(none.status());

    // GET requests are never Origin-checked.
    const get = await page.request.get(`${BASE}/api/friends`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' },
    });
    expect(get.status()).toBe(200);
  });
});

test.describe('G2 — Mutation rate limit + storage quota (isolated server)', () => {
  let child: ChildProcess;
  const ALT = 'https://localhost:3451';

  test.beforeAll(async () => {
    const serverDir = path.join(__dirname, '..', 'server');
    const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
    if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
    child = spawn(bin, [], {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: '3450',
        HTTPS_PORT: '3451',
        LOGIN_IP_MAX: '100000',
        LOGIN_USER_MAX: '100000',
        AUTH_PARAMS_IP_MAX: '100000',
        HMAC_KEY_IP_MAX: '100000',
        // Tiny budgets so the suite can hit them deterministically:
        MUTATION_USER_MAX: '4',          // 4 mutating calls per 10s per user
        MUTATION_IP_MAX: '100000',       // don't trip the IP bucket
        FILE_STORAGE_QUOTA_BYTES: '2000' // 2 KB per-user storage cap
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch('http://localhost:3450/').catch(() => null);
        if (r) { up = true; break; }
      } catch (_) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(up, 'isolated server came up').toBe(true);
  });

  test.afterAll(async () => {
    if (child) child.kill();
  });

  test('authed mutations over the budget get 429; GETs are not limited', async ({ page }) => {
    const uname = 'ratelimit_' + Date.now();
    await page.goto(ALT + '/login.html');
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', uname);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));

    // A few allowed (register flow consumes a little budget), then rejected.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      statuses.push(res.status());
    }
    const rejected = statuses.filter((s) => s === 429);
    expect(rejected.length, `at least one 429 in ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    // GETs are never limited.
    const g1 = await page.request.get(`${ALT}/api/friends`, { headers: { Authorization: `Bearer ${token}` } });
    const g2 = await page.request.get(`${ALT}/api/friends`, { headers: { Authorization: `Bearer ${token}` } });
    expect(g1.status()).toBe(200);
    expect(g2.status()).toBe(200);
  });

  test('file upload over the storage quota is rejected with 413', async ({ page }) => {
    const uname = 'quota_' + Date.now();
    await page.goto(ALT + '/login.html');
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', uname);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));

    // First upload: small (fits the 2KB cap).
    const small = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 500 },
    });
    expect(small.status()).toBe(200);

    // Second upload: 5000 bytes — over the 2000-byte per-user cap → 413.
    const big = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 5000 },
    });
    expect(big.status()).toBe(413);
  });
});

test.describe('G4 — Admin audit log', () => {
  test('admin actions are recorded and readable via /api/admin/audit-log', async ({ page }) => {
    // Log into admin (first-time setup will set the password).
    await page.goto(BASE + '/admin.html');
    await page.waitForSelector('#admin-login-form', { timeout: 10000 });
    const passwordField = page.locator('#admin-password');
    const loginBtn = page.locator('#admin-login-btn');
    for (const pw of ['auditadmin', 'admin123', 'admin']) {
      await passwordField.fill(pw);
      await loginBtn.click();
      await page.waitForTimeout(800);
      if (await page.locator('#admin-panel').isVisible().catch(() => false)) break;
      const subtitle = await page.textContent('#admin-login-subtitle').catch(() => '');
      if (subtitle && subtitle.includes('set')) {
        await passwordField.fill(pw);
        await loginBtn.click();
        await page.waitForTimeout(800);
        if (await page.locator('#admin-panel').isVisible().catch(() => false)) break;
      }
    }
    await expect(page.locator('#admin-panel')).toBeVisible({ timeout: 5000 });
    const adminToken = await page.evaluate(() => sessionStorage.getItem('admin_token'));
    expect(adminToken).toBeTruthy();

    // Click the Audit Log tab — the table must render.
    await page.locator('.tab-btn[data-tab="audit-log"]').click();
    await page.waitForTimeout(800);
    const tbodyText = await page.textContent('#audit-log-list');
    expect(tbodyText || '').toContain('admin_login');

    // API returns the same records, newest first.
    const res = await page.request.get(`${BASE}/api/admin/audit-log`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const actions = rows.map((r: any) => r.action);
    expect(actions).toContain('admin_login');
    // Never log tokens/passwords.
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toMatch(/password|token=/i);
    }
  });
});

test.describe('G5 — Client-side magic-byte validation', () => {
  test('a file whose declared type contradicts its bytes is rejected before encryption', async ({ page }) => {
    await page.goto(BASE + '/login.html');
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', 'magic_' + Date.now());
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

    // A .png file that is actually text → checkUploadMagic must return an error.
    const bad = await page.evaluate(async () => {
      const fake = new File(['this is definitely not a png image'], 'photo.png', { type: 'image/png' });
      const err = await (window as any).checkUploadMagic(fake);
      return err;
    });
    expect(bad).toBeTruthy();
    expect(String(bad)).toContain('File type mismatch');

    // A genuine PNG header → no error.
    const good = await page.evaluate(async () => {
      // 1x1 PNG (8-byte magic + minimal IHDR).
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const real = new File([bytes], 'ok.png', { type: 'image/png' });
      return await (window as any).checkUploadMagic(real);
    });
    expect(good).toBeNull();

    // application/octet-stream passes through (arbitrary files are legal).
    const any = await page.evaluate(async () => {
      const f = new File(['random stuff'], 'blob.bin', { type: 'application/octet-stream' });
      return await (window as any).checkUploadMagic(f);
    });
    expect(any).toBeNull();
  });
});
