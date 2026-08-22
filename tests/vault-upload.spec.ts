import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

const ALT = 'https://localhost:3453';
const VAULT_QUOTA = 1024 * 1024 * 1024; // 1 GB in bytes

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

let child: ChildProcess;
let tmpDb: string;

async function registerUser(request: any, uname: string): Promise<string> {
  // The server expects a client-computed HMAC-SHA256 hash (64 hex chars)
  const hashedPw = 'a'.repeat(64);
  const res = await request.post(`${ALT}/api/register`, {
    data: { username: uname, password: hashedPw },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(data.token).toBeTruthy();
  return data.token as string;
}

async function setQuota(request: any, adminToken: string, quotaBytes: number) {
  const res = await request.put(`${ALT}/api/admin/runtime-config`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { file_storage_quota_bytes: quotaBytes },
  });
  expect(res.ok()).toBeTruthy();
}

async function adminLogin(request: any, password: string): Promise<string> {
  let res = await request.post(`${ALT}/api/admin/login`, { data: { password } });
  const data = await res.json();
  if (!res.ok() || !data.token) {
    res = await request.post(`${ALT}/api/admin/login`, { data: { password } });
    if (!res.ok()) throw new Error('admin login failed: ' + (await res.text()));
  }
  const final = await res.json();
  expect(final.token).toBeTruthy();
  return final.token as string;
}

// Vault upload helper: sends raw binary body + metadata in headers.
// `storedSize` controls the quota accounting (header value).
// The actual body is `bodySize` bytes of zeros (fast to allocate).
async function vaultUpload(
  request: any,
  token: string,
  fileId: string,
  storedSize: number,
  bodySize: number = 1024, // default: tiny body, quota driven by storedSize header
) {
  const body = Buffer.alloc(bodySize, 0);
  const res = await request.post(`${ALT}/api/vault/upload`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'x-vault-file-id': fileId,
      'x-vault-filename': 'dGVzdA==',           // base64 "test"
      'x-vault-filename-nonce': 'dGVzdG5vbmNl',  // dummy
      'x-vault-mime': 'dGVzdA==',
      'x-vault-mime-nonce': 'dGVzdG5vbmNl',
      'x-vault-original-size': String(bodySize),
      'x-vault-stored-size': String(storedSize),
      'x-vault-file-key': 'dGVzdA==',
      'x-vault-file-key-nonce': 'dGVzdG5vbmNl',
      'x-vault-hash': 'dGVzdGhhc2g=',
      'x-vault-compression': 'none',
    },
    data: body,
  });
  return res;
}

async function vaultList(request: any, token: string) {
  const res = await request.get(`${ALT}/api/vault/files`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function vaultDelete(request: any, token: string, fileId: string) {
  const res = await request.delete(`${ALT}/api/vault/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res;
}

test.describe('Vault upload — quota enforcement (isolated server)', () => {
  let adminToken: string;
  let userToken: string;

  test.beforeAll(async ({ request }) => {
    const serverDir = path.join(__dirname, '..', 'server');
    const bin = path.join(
      serverDir,
      'target',
      'debug',
      process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat',
    );
    if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);

    tmpDb = path.join(serverDir, `vault-test-${Date.now()}.db`);
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
        REGISTER_IP_MAX: '100000',
        // Start with unlimited quota; we'll set it to 1 GB via admin API
        FILE_STORAGE_QUOTA_BYTES: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let up = false;
    for (let i = 0; i < 60; i++) {
      if (await httpsProbe(ALT + '/')) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(up, 'isolated server came up').toBe(true);

    adminToken = await adminLogin(request, 'vaultadmin');
    userToken = await registerUser(request, 'vaultuser1');
  });

  test.afterAll(async () => {
    if (child) child.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (tmpDb) {
      try { fs.unlinkSync(tmpDb); } catch (_) {}
      try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('1 GB upload succeeds within quota', async ({ request }) => {
    // Set quota to 1 GB
    await setQuota(request, adminToken, VAULT_QUOTA);

    const size1GB = 1024 * 1024 * 1024; // 1,073,741,824 bytes
    const fileId = crypto.randomUUID();

    // Upload 1 GB — use a small body but set stored_size to 1 GB
    const res = await vaultUpload(request, userToken, fileId, size1GB);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.file_id).toBe(fileId);

    // Verify vault reports the correct total size
    const list = await vaultList(request, userToken);
    expect(list.total_size).toBe(size1GB);
    expect(list.files.length).toBe(1);
  });

  test('delete frees vault space', async ({ request }) => {
    const list = await vaultList(request, userToken);
    expect(list.files.length).toBe(1);
    const fileId = list.files[0].id;

    const delRes = await vaultDelete(request, userToken, fileId);
    expect(delRes.status()).toBe(200);

    const afterDel = await vaultList(request, userToken);
    expect(afterDel.files.length).toBe(0);
    expect(afterDel.total_size).toBe(0);
  });

  test('300 MB + 800 MB = 1100 MB exceeds 1 GB quota → second upload rejected', async ({ request }) => {
    const size300MB = 300 * 1024 * 1024;
    const size800MB = 800 * 1024 * 1024;

    // First upload: 300 MB — should succeed
    const res1 = await vaultUpload(request, userToken, crypto.randomUUID(), size300MB);
    expect(res1.status()).toBe(200);

    // Second upload: 800 MB — 300+800=1100 > 1024 → should fail with 413
    const res2 = await vaultUpload(request, userToken, crypto.randomUUID(), size800MB);
    expect(res2.status()).toBe(413);
    const errBody = await res2.json();
    expect(errBody.error).toContain('Vault size limit');
  });

  test('300 MB + 700 MB = 1000 MB fits in 1 GB quota → succeeds', async ({ request }) => {
    // Vault still has the 300 MB file from the previous test.
    const size700MB = 700 * 1024 * 1024;

    // 300+700=1000 < 1024 → should succeed
    const res = await vaultUpload(request, userToken, crypto.randomUUID(), size700MB);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify total size
    const list = await vaultList(request, userToken);
    expect(list.total_size).toBe(300 * 1024 * 1024 + size700MB);
  });

  test('large binary body (300 MB) is accepted by body limit (was 256 MB)', async ({ request }) => {
    // Delete all vault files first so quota is available
    const list = await vaultList(request, userToken);
    for (const f of list.files) {
      await vaultDelete(request, userToken, f.id);
    }
    const after = await vaultList(request, userToken);
    expect(after.total_size).toBe(0);

    // Set quota high enough for this test
    await setQuota(request, adminToken, 500 * 1024 * 1024); // 500 MB

    // Upload 300 MB of actual binary data (not just a 1 KB body with a header)
    // The old DefaultBodyLimit::max(256 MB) would have rejected this.
    const bodySize = 300 * 1024 * 1024; // 314,572,800 bytes
    const res = await vaultUpload(request, userToken, crypto.randomUUID(), bodySize, bodySize);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the server stored the full blob
    const list2 = await vaultList(request, userToken);
    expect(list2.files.length).toBe(1);
    expect(list2.total_size).toBe(bodySize);
  });

  test('1 GB actual binary body uploaded and downloaded end-to-end', async ({ request }) => {
    // Clean slate
    const list = await vaultList(request, userToken);
    for (const f of list.files) {
      await vaultDelete(request, userToken, f.id);
    }
    const after = await vaultList(request, userToken);
    expect(after.total_size).toBe(0);

    // Quota must be ≥ 1 GB for this test
    await setQuota(request, adminToken, VAULT_QUOTA);

    const size1GB = 1024 * 1024 * 1024; // 1,073,741,824 bytes
    const fileId = crypto.randomUUID();

    // --- Upload: send 1 GB of actual binary data ---
    const uploadRes = await vaultUpload(
      request, userToken, fileId, size1GB, size1GB,
    );
    expect(uploadRes.status()).toBe(200);
    const uploadBody = await uploadRes.json();
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.file_id).toBe(fileId);

    // --- Verify vault metadata ---
    const listAfterUpload = await vaultList(request, userToken);
    expect(listAfterUpload.files.length).toBe(1);
    expect(listAfterUpload.total_size).toBe(size1GB);
    expect(listAfterUpload.files[0].id).toBe(fileId);

    // --- Download and verify byte length matches ---
    const dlRes = await request.get(
      `${ALT}/api/vault/files/${fileId}`,
      { headers: { Authorization: `Bearer ${userToken}` } },
    );
    expect(dlRes.status()).toBe(200);
    const dlBuf = await dlRes.body();      // Buffer
    expect(dlBuf.length).toBe(size1GB);

    // Verify all bytes are zero (what we uploaded)
    const allZero = dlBuf.every((b: number) => b === 0);
    expect(allZero).toBe(true);

    // --- Delete and confirm space freed ---
    const delRes = await vaultDelete(request, userToken, fileId);
    expect(delRes.status()).toBe(200);
    const listAfterDel = await vaultList(request, userToken);
    expect(listAfterDel.files.length).toBe(0);
    expect(listAfterDel.total_size).toBe(0);
  });
});
