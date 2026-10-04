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
    const bin = path.join(serverDir, 'target', 'release', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
    if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
    tmpDb = path.join(serverDir, `runtime-test-${Date.now()}.db`);
    child = spawn(bin, [], {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: '3452',
        HTTPS_PORT: '3453',
        DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
        LOGIN_IP_MAX: '100000',
        LOGIN_USER_MAX: '100000',
        AUTH_PARAMS_IP_MAX: '100000',
        HMAC_KEY_IP_MAX: '100000',
        MUTATION_USER_MAX: '100000',
        MUTATION_IP_MAX: '100000',
        FILE_STORAGE_QUOTA_BYTES: '100000000000',
        // This suite logs into the admin panel once per test (each helper call
        // can be two POSTs) from one IP, which blows through the default
        // per-IP admin-login budget halfway down the file. 0 disables it, the
        // same way playwright.config.ts does for the main server.
        ADMIN_LOGIN_IP_MAX: '0',
        // Several tests register a fresh account from the same IP.
        REGISTER_IP_MAX: '100000',
        // The quota/size tests call /api/client-config and /api/me repeatedly.
        CLIENT_CONFIG_IP_MAX: '100000',
        REAUTH_IP_MAX: '0',
        REAUTH_USER_MAX: '0',
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
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
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

  test('finding 7: windows, the per-username/join/voice caps and the icon + chunk size caps are live-tunable', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');

    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {
        login_window_secs: 120,
        register_user_max: 33,
        join_server_user_max: 44,
        voice_media_max: 5555,
        icon_slot_max_bytes: 8 * 1024 * 1024,
        upload_chunk_max_bytes: 2 * 1024 * 1024,
      },
    });
    expect(put.status()).toBe(200);

    const cfg = await (
      await page.request.get(`${ALT}/api/admin/runtime-config`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(cfg.login_window_secs).toBe(120);
    expect(cfg.register_user_max).toBe(33);
    expect(cfg.join_server_user_max).toBe(44);
    expect(cfg.voice_media_max).toBe(5555);
    expect(cfg.icon_slot_max_bytes).toBe(8 * 1024 * 1024);
    expect(cfg.upload_chunk_max_bytes).toBe(2 * 1024 * 1024);
    // Provenance is tracked for the new fields too.
    expect(cfg.sources.login_window_secs).toBe('db');
    expect(cfg.sources.icon_slot_max_bytes).toBe('db');

    // The icon cap reaches the page through the public endpoint, which is what
    // makes a raised limit effective without a client release.
    const pub = await (await page.request.get(`${ALT}/api/client-config`)).json();
    expect(pub.icon_slot_max_bytes).toBe(8 * 1024 * 1024);

    // A zero-second window would make its limiter deny every request, so it is
    // rejected instead of silently applied.
    const bad = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { login_window_secs: 0 },
    });
    expect(bad.status()).toBe(400);

    // Restore the defaults.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {
        login_window_secs: 300,
        register_user_max: 10,
        join_server_user_max: 10,
        voice_media_max: 3000,
        icon_slot_max_bytes: 4 * 1024 * 1024,
        upload_chunk_max_bytes: 1024 * 1024,
      },
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

    // The IP bucket exists too — keyed by the server-computed `h1_…` hash,
    // never by a raw IP (the usage view is one of the places the hash shows).
    expect(data.ips.length).toBeGreaterThanOrEqual(1);
    expect(data.ips[0].count).toBeGreaterThanOrEqual(1);
    expect(data.ips[0].ip).toMatch(/^h1_[0-9a-f]{32}$/);
    // Nothing in the response may leak the raw client address.
    expect(JSON.stringify(data)).not.toContain('127.0.0.1');
    expect(JSON.stringify(data)).not.toContain('::1');
    expect(JSON.stringify(data)).not.toContain('localhost');

    // The 429 was recorded with the username + ip + timestamp.
    expect((data.recent_429s as any[]).some((h) => h.username === uname)).toBeTruthy();
    expect((data.recent_429s as any[]).some((h) => h.ip.length > 0)).toBeTruthy();
    expect((data.recent_429s as any[]).every((h) => /^h1_[0-9a-f]{32}$/.test(h.ip))).toBeTruthy();
    expect((data.recent_429s as any[]).some((h) => h.username === uname && h.ip.startsWith('h1_'))).toBeTruthy();
    expect((data.recent_429s as any[]).some((h) => h.ts > 0)).toBeTruthy();

    // Restore the budget so later tests are unaffected.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 100000 },
    });
  });

  test('per-IP limits key on a server-side hash; client-supplied hashes are ignored', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_user_max: 100000, mutation_ip_max: 2 },
    });

    const uname = 'rthash_' + Date.now();
    const token = await registerUser(page, uname);
    const ipA = '203.0.113.77';
    const ipB = '203.0.113.78';

    // Five mutations from ONE IP. Every request claims a different client-side
    // hash; the server must ignore all of them and bucket by its own hash of
    // the IP it derived — so the per-IP budget trips anyway.
    const statuses: number[] = [];
    const spoofHeaders = ['h1_' + 'aa'.repeat(16), 'h1_' + 'bb'.repeat(16)];
    for (let i = 0; i < 5; i++) {
      const res = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forwarded-For': ipA,
          'X-Client-IP-Hash': spoofHeaders[i % 2],
          'X-Rate-Limit-IP': spoofHeaders[(i + 1) % 2],
        },
      });
      statuses.push(res.status());
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    const usage = await (
      await page.request.get(`${ALT}/api/admin/rate-limit-usage`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    const rowA = (usage.ips as any[]).find((r) => r.count >= 2);
    expect(rowA, 'bucket for the exhausted IP exists').toBeTruthy();
    expect(rowA.ip).toMatch(/^h1_[0-9a-f]{32}$/);
    expect(usage.ips.length).toBeGreaterThanOrEqual(1);
    // The hashes the client made up must never appear as buckets.
    expect((usage.ips as any[]).some((r) => spoofHeaders.includes(r.ip))).toBeFalsy();

    // A different IP is NOT blocked by that budget, even when it presents the
    // exhausted bucket's hash: the header is ignored. (And the exhausted IP
    // stays blocked even when it presents a fresh-looking hash, above.)
    const other = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': ipB,
        'X-Client-IP-Hash': rowA.ip,
      },
    });
    expect(other.status()).toBe(200);
    const stillBlocked = await page.request.post(`${ALT}/api/friend-code/regenerate`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': ipA,
        'X-Client-IP-Hash': 'h1_' + '00'.repeat(16),
      },
    });
    expect(stillBlocked.status()).toBe(429);

    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { mutation_ip_max: 100000 },
    });
  });

  test('newly exposed limits round-trip: voice signal, nonce TTL/cap, session cap, fail window', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {
        voice_signal_max: 111,
        voice_signal_window_secs: 22,
        login_user_fail_window_secs: 333,
        login_nonce_ttl_secs: 44,
        login_nonce_max_per_user: 5,
        max_session_secs: 86400,
      },
    });
    expect(put.status()).toBe(200);

    const cfg = await (
      await page.request.get(`${ALT}/api/admin/runtime-config`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(cfg.voice_signal_max).toBe(111);
    expect(cfg.voice_signal_window_secs).toBe(22);
    expect(cfg.login_user_fail_window_secs).toBe(333);
    expect(cfg.login_nonce_ttl_secs).toBe(44);
    expect(cfg.login_nonce_max_per_user).toBe(5);
    expect(cfg.max_session_secs).toBe(86400);
    for (const key of [
      'voice_signal_max',
      'voice_signal_window_secs',
      'login_user_fail_window_secs',
      'login_nonce_ttl_secs',
      'login_nonce_max_per_user',
      'max_session_secs',
    ]) {
      expect(cfg.sources[key]).toBe('db');
    }

    // Every one of them is persisted in admin_config (survives a restart).
    const rows = (await (
      await page.request.get(`${ALT}/api/admin/admin-config`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json()) as Array<{ key: string; value: string }>;
    expect(rows.some((r) => r.key === 'voice_signal_max' && r.value === '111')).toBeTruthy();
    expect(rows.some((r) => r.key === 'max_session_secs' && r.value === '86400')).toBeTruthy();

    // A zero-second window/TTL is still rejected.
    for (const key of ['voice_signal_window_secs', 'login_user_fail_window_secs', 'login_nonce_ttl_secs', 'max_session_secs']) {
      const bad = await page.request.put(`${ALT}/api/admin/runtime-config`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        data: { [key]: 0 },
      });
      expect(bad.status(), key + '=0 is rejected').toBe(400);
    }

    // Restore defaults.
    await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {
        voice_signal_max: 300,
        voice_signal_window_secs: 10,
        login_user_fail_window_secs: 900,
        login_nonce_ttl_secs: 120,
        login_nonce_max_per_user: 8,
        max_session_secs: 30 * 24 * 60 * 60,
      },
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

  test('finding 7: request-body cap is live-configurable (413, then served again)', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');

    // Tighten the default request-body limit to 2 KiB live.
    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { body_limit_default_bytes: 2048 },
    });
    expect(put.status()).toBe(200);

    const get = await page.request.get(`${ALT}/api/admin/runtime-config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cfg = await get.json();
    expect(cfg.body_limit_default_bytes).toBe(2048);
    expect(cfg.sources.body_limit_default_bytes).toBe('db');

    // A body over the live limit is rejected up front with 413.
    const big = await page.request.post(`${ALT}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'nobody', password: 'x'.repeat(4096) },
    });
    expect(big.status()).toBe(413);

    // A small body still reaches the handler (401, not 413).
    const small = await page.request.post(`${ALT}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'nobody', password: 'x' },
    });
    expect(small.status()).toBe(401);

    // Loosen it live — the very next request is served again (no restart).
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { body_limit_default_bytes: 64 * 1024 * 1024 },
    });
    expect(putBack.status()).toBe(200);
    const after = await page.request.post(`${ALT}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'nobody', password: 'x'.repeat(4096) },
    });
    expect(after.status()).toBe(401);
  });

  test('finding 7: WebSocket message/frame caps are live-configurable', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const token = await registerUser(page, 'rtws_' + Date.now());

    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { ws_max_message_bytes: 4096, ws_max_frame_bytes: 4096, ws_socket_budget_bytes: 8192, ws_socket_budget_window_secs: 5 },
    });
    expect(put.status()).toBe(200);
    const cfg = await (await page.request.get(`${ALT}/api/admin/runtime-config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })).json();
    expect(cfg.ws_max_message_bytes).toBe(4096);
    expect(cfg.ws_socket_budget_bytes).toBe(8192);
    expect(cfg.ws_socket_budget_window_secs).toBe(5);
    expect(cfg.sources.ws_max_message_bytes).toBe('db');

    // A message over the configured cap closes the socket instead of being
    // buffered (the merge of this limit happens at WS handshake time).
    const result = await page.evaluate(async ({ token }) => {
      return await new Promise<{ closed: boolean }>((resolve) => {
        const ws = new WebSocket(`wss://${location.host}/ws`);
        const out = { closed: false };
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ type: 'auth', token, padding: 'x'.repeat(16 * 1024) }));
          } catch (_) { /* send may fail client-side */ }
        };
        ws.onclose = () => { out.closed = true; resolve(out); };
        ws.onerror = () => {};
        setTimeout(() => resolve(out), 10000);
      });
    }, { token });
    expect(result.closed, 'the socket must be closed, not left half-open').toBe(true);

    // Restore the defaults so later suites on this server are unaffected.
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: {
        ws_max_message_bytes: 1024 * 1024,
        ws_max_frame_bytes: 1024 * 1024,
        ws_socket_budget_bytes: 32 * 1024 * 1024,
        ws_socket_budget_window_secs: 10,
      },
    });
    expect(putBack.status()).toBe(200);
  });

  test('finding 7: auth rate limits are live-configurable', async ({ page }) => {
    const adminToken = await adminLogin(page, 'rtadmin');
    const uname = 'rtlogin_' + Date.now();
    await registerUser(page, uname);

    // Tighten the per-username failure budget to 1 live.
    const put = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { login_user_fail_max: 1 },
    });
    expect(put.status()).toBe(200);

    const fail1 = await page.request.post(`${ALT}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: uname, password: 'wrong-password-1' },
    });
    expect(fail1.status()).toBe(401);
    const fail2 = await page.request.post(`${ALT}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: uname, password: 'wrong-password-2' },
    });
    expect(fail2.status(), 'the configured budget of 1 failure must block the next attempt').toBe(429);

    // Restore the default.
    const putBack = await page.request.put(`${ALT}/api/admin/runtime-config`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      data: { login_user_fail_max: 3 },
    });
    expect(putBack.status()).toBe(200);
  });
});
