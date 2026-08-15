import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

// F1: the plaintext-HTTP listener now 301-redirects to HTTPS, so liveness
// must probe the HTTPS port (self-signed cert → rejectUnauthorized: false).
function httpsProbe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

// Runtime-tunable G2 limits (admin-config tab): the admin can read and change
// the mutation rate limits + storage quota live, without a server restart.
const HTTP = 'http://localhost:3452';
const ALT = 'https://localhost:3453';

let child: ChildProcess;
let tmpDb: string;

async function registerUser(page: any, uname: string) {
  await page.goto(ALT + '/login.html');
  await page.waitForTimeout(400);
  await page.click('#show-register');
  await page.fill('#register-username', uname);
  await page.fill('#register-password', 'password123');
  await page.fill('#register-confirm-password', 'password123');
  await page.click('#register-form button[type="submit"]');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
  return token as string;
}

async function adminLogin(page: any, password: string) {
  // Fresh DB → first login sets the password, second call verifies. Do both
  // through the API so the returned admin token is captured for later calls.
  let res = await page.request.post(`${ALT}/api/admin/login`, { data: { password } });
  const data = await res.json();
  if (!res.ok() || !data.token) {
    // setup_complete path: log in again with the same password.
    res = await page.request.post(`${ALT}/api/admin/login`, { data: { password } });
    if (!res.ok()) throw new Error('admin login failed: ' + (await res.text()));
  }
  const final = await res.json();
  expect(final.token).toBeTruthy();
  return final.token as string;
}

test.describe('Admin runtime config (G2) — isolated server + temp DB', () => {
  test.beforeAll(async () => {
    const serverDir = path.join(__dirname, '..', 'server');
    const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
    if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
    tmpDb = path.join(serverDir, `runtime-test-${Date.now()}.db`);
    child = spawn(bin, [], {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: '3452',
        HTTPS_PORT: '3453',
        DATABASE_URL: tmpDb,
        LOGIN_IP_MAX: '100000',
        LOGIN_USER_MAX: '100000',
        AUTH_PARAMS_IP_MAX: '100000',
        HMAC_KEY_IP_MAX: '100000',
        MUTATION_USER_MAX: '100000',
        MUTATION_IP_MAX: '100000',
        FILE_STORAGE_QUOTA_BYTES: '100000000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (await httpsProbe(ALT + '/')) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(up, 'isolated server came up').toBe(true);
  });

  test.afterAll(async () => {
    if (child) child.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (tmpDb) {
      try { fs.unlinkSync(tmpDb); } catch (_) {}
    }
  });

  test('GET returns effective values with sources (env → default here)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const res = await page.request.get(`${ALT}/api/admin/runtime-config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const cfg = await res.json();
    expect(cfg.mutation_user_max).toBe(100000); // env override
    expect(cfg.mutation_ip_max).toBe(100000);
    expect(cfg.file_storage_quota_bytes).toBe(100000000000);
    expect(cfg.max_file_size_mb).toBe(1024); // default 1024 MB (1 GB)
    expect(cfg.sources.mutation_user_max).toBe('env');
    expect(cfg.sources.max_file_size_mb).toBe('default');
  });

  test('admin can tighten the per-user mutation budget live (no restart)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const token = await registerUser(page, 'rtlimit_' + Date.now());

    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 3 },
    });
    expect(put.status()).toBe(200);

    // Budget of 3 → the 4th mutating call is rejected.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      statuses.push(res.status());
    }
    const rejected = statuses.filter((s) => s === 429);
    expect(rejected.length, `expected 429s in ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(1);

    // Loosen it again live — the very next call must succeed (no restart).
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 100000 },
    });
    expect(putBack.status()).toBe(200);
    const again = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(again.status()).toBe(200);

    // The change is audit-logged (G4).
    const audit = await page.request.get(`${ALT}/api/admin/audit-log`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const rows = await audit.json();
    const entries = Array.isArray(rows) ? rows : (rows.entries || rows.log || []);
    expect(JSON.stringify(entries)).toContain('admin_set_runtime_config');
    expect(JSON.stringify(entries)).toContain('mutation_user_max=3');
  });

  test('admin can tighten the storage quota live (413 on the next upload)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const token = await registerUser(page, 'rtquota_' + Date.now());

    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { file_storage_quota_bytes: 1000 },
    });
    expect(put.status()).toBe(200);

    const small = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 500 },
    });
    expect(small.status()).toBe(200);

    const big = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 5000 },
    });
    expect(big.status()).toBe(413);

    // Restore so later tests in other files (on this server) aren't affected.
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { file_storage_quota_bytes: 100000000000 },
    });
    expect(putBack.status()).toBe(200);
  });

  test('admin can change the max file size live (413 on the next upload init)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const token = await registerUser(page, 'rtfilesize_' + Date.now());

    // Tighten to 1 MB.
    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: 1 },
    });
    expect(put.status()).toBe(200);

    const small = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 500 * 1024 }, // 500 KB — under 1 MB
    });
    expect(small.status()).toBe(200);

    const big = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 2 * 1024 * 1024 }, // 2 MB — over 1 MB
    });
    expect(big.status()).toBe(413);

    // The cap is PER FILE, not accumulated: four 500 KB files (2 MB total,
    // well over the 1 MB limit in aggregate) are all accepted, because each
    // individual file is under the cap. Users can upload as many files as
    // they want up to the per-file limit (the separate per-user storage
    // quota is what caps the total).
    for (let i = 0; i < 4; i++) {
      const multi = await page.request.post(`${ALT}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: 500 * 1024 },
      });
      expect(multi.status(), `multi-upload file ${i + 1} should be accepted`).toBe(200);
    }

    // 0 = unlimited: even the oversized file is accepted once unset.
    const unlimited = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: 0 },
    });
    expect(unlimited.status()).toBe(200);
    const afterUnlimited = await page.request.post(`${ALT}/api/files/init`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { size: 2 * 1024 * 1024 },
    });
    expect(afterUnlimited.status()).toBe(200);

    // Restore the 1024 MB default.
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: 1024 },
    });
    expect(putBack.status()).toBe(200);
  });

  test('public /api/client-config exposes the effective max file size (no auth)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');

    // Default first: 1024 MB = 1 GiB in bytes.
    let res = await page.request.get(`${ALT}/api/client-config`);
    expect(res.status()).toBe(200);
    let cfg = await res.json();
    expect(cfg.max_file_size_mb).toBe(1024);
    expect(cfg.max_file_size_bytes).toBe(1024 * 1024 * 1024);

    // Live change via admin → the public endpoint reflects it immediately.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: 3 },
    });
    res = await page.request.get(`${ALT}/api/client-config`);
    cfg = await res.json();
    expect(cfg.max_file_size_mb).toBe(3);
    expect(cfg.max_file_size_bytes).toBe(3 * 1024 * 1024);

    // Restore.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: 1024 },
    });
  });

  test('saved values flip source to db, persist in admin_config, and hash is hidden', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 77, mutation_ip_max: 88 },
    });

    const get = await page.request.get(`${ALT}/api/admin/runtime-config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cfg = await get.json();
    expect(cfg.mutation_user_max).toBe(77);
    expect(cfg.mutation_ip_max).toBe(88);
    expect(cfg.sources.mutation_user_max).toBe('db');
    expect(cfg.sources.mutation_ip_max).toBe('db');

    // The generic admin-config listing shows the new keys (DB persistence) and
    // never exposes the password hash.
    const list = await page.request.get(`${ALT}/api/admin/admin-config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const rows = (await list.json()) as Array<{ key: string; value: string }>;
    expect(rows.some((r) => r.key === 'mutation_user_max' && r.value === '77')).toBeTruthy();
    expect(rows.some((r) => r.key === 'mutation_ip_max' && r.value === '88')).toBeTruthy();
    expect(rows.some((r) => r.key === 'password_hash')).toBeFalsy();
  });

  test('live usage view: buckets + recent 429s are reported and require admin auth', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    // Unauthenticated access is rejected.
    const anon = await page.request.get(`${ALT}/api/admin/rate-limit-usage`);
    expect(anon.status()).toBe(401);

    // Tight budget → a real 429 is produced and recorded.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 2 },
    });
    const uname = 'rtusage_' + Date.now();
    const token = await registerUser(page, uname);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      statuses.push(res.status());
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    const res = await page.request.get(`${ALT}/api/admin/rate-limit-usage`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.window_seconds).toBe(10);

    // The user bucket is visible with count, limit, and remaining window.
    const myRow = (data.users as any[]).find((r) => r.username === uname);
    expect(myRow, 'user bucket present').toBeTruthy();
    expect(myRow.count).toBeGreaterThanOrEqual(1);
    expect(myRow.limit).toBe(2);
    expect(myRow.window_remaining_s).toBeLessThanOrEqual(10);

    // The IP bucket exists too.
    expect(data.ips.length).toBeGreaterThanOrEqual(1);
    expect(data.ips[0].count).toBeGreaterThanOrEqual(1);

    // The 429 was recorded with the username + ip + timestamp.
    expect((data.recent_429s as any[]).some((h) => h.username === uname)).toBeTruthy();
    expect((data.recent_429s as any[]).some((h) => h.ip.length > 0)).toBeTruthy();
    expect((data.recent_429s as any[]).some((h) => h.ts > 0)).toBeTruthy();

    // Restore the budget so later tests are unaffected.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 100000 },
    });
  });

  test('invalid values are rejected (too big / negative / empty)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const tooBig = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 5000000000 },
    });
    expect(tooBig.status()).toBe(400);
    const negative = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { file_storage_quota_bytes: -5 },
    });
    expect(negative.status()).toBe(400);
    const negativeSize = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { max_file_size_mb: -1 },
    });
    expect(negativeSize.status()).toBe(400);
    const empty = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {},
    });
    expect(empty.status()).toBe(400);
  });
});
