import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

// Isolated server (ports 3465/3466).
const PORT = '3465';
const HTTPS_PORT = '3466';
const ALT = `https://127.0.0.1:${HTTPS_PORT}`;

function makePng(): Buffer {
    const zlib = require('zlib');
    const w = 4, h = 4;
    const raw = Buffer.alloc(1 + w * h * 3);
    raw[0] = 0;
    for (let i = 1; i < raw.length; i++) raw[i] = 0x40 + (i % 200);
    function crc32(buf: Buffer): Buffer {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
        c = (c ^ 0xffffffff) >>> 0; const b = Buffer.alloc(4); b.writeUInt32BE(c); return b;
    }
    function chunk(type: Buffer, data: Buffer): Buffer {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const tad = Buffer.concat([type, data]);
        return Buffer.concat([len, tad, crc32(tad)]);
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([sig, chunk(Buffer.from('IHDR'), ihdr), chunk(Buffer.from('IDAT'), zlib.deflateSync(raw)), chunk(Buffer.from('IEND'), Buffer.alloc(0))]);
}

async function registerUser(page: Page, username: string) {
    await page.goto(`${ALT}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function loginUser(page: Page, username: string) {
    await page.goto(`${ALT}/login.html`);
    await page.waitForTimeout(500);
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

test.describe('File persistence across server restart', () => {
    let child: ChildProcess;
    let tmpDb: string;

    async function startServer(request: any) {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        child = spawn(bin, [], {
            cwd: serverDir,
            env: {
                ...process.env,
                PORT,
                HTTPS_PORT,
                DATABASE_URL: tmpDb,
                UPLOAD_DIR: tmpDb + '-uploads',
                LOGIN_IP_MAX: '100000', LOGIN_USER_MAX: '100000', REGISTER_IP_MAX: '100000',
                AUTH_PARAMS_IP_MAX: '100000', HMAC_KEY_IP_MAX: '100000', LOGIN_2FA_IP_MAX: '100000',
                ADMIN_LOGIN_IP_MAX: '100000', KILL_SWITCH_IP_MAX: '100000', KILL_SWITCH_USER_MAX: '100000',
                FILE_STORAGE_QUOTA_BYTES: '100000000000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let up = false;
        for (let i = 0; i < 80; i++) {
            try {
                const r = await request.get(`${ALT}/`);
                if (r.status() < 500) { up = true; break; }
            } catch (_) { /* not up yet */ }
            await new Promise((r2) => setTimeout(r2, 300));
        }
        expect(up, 'isolated server came up').toBe(true);
    }

    test.beforeAll(async ({ request }) => {
        const serverDir = path.join(__dirname, '..', 'server');
        const bin = path.join(serverDir, 'target', 'debug', process.platform === 'win32' ? 'e2e-chat.exe' : 'e2e-chat');
        if (!fs.existsSync(bin)) throw new Error('server binary not found at ' + bin);
        tmpDb = path.join(serverDir, `restart-probe-${Date.now()}.db`);
        await startServer(request);
        // First login sets up the admin password (fresh DB → admin setup page).
        const setup = await request.post(`${ALT}/api/admin/login`, { data: { password: 'probe-admin' } });
        expect(setup.ok(), 'admin setup on probe server').toBeTruthy();
    });

    test.afterAll(async () => {
        if (child) child.kill();
        await new Promise((r) => setTimeout(r, 500));
        if (tmpDb) {
            try { fs.unlinkSync(tmpDb); } catch (_) {}
            try { fs.unlinkSync(tmpDb + '-wal'); } catch (_) {}
            try { fs.unlinkSync(tmpDb + '-shm'); } catch (_) {}
            try { fs.rmSync(tmpDb + '-uploads', { recursive: true, force: true }); } catch (_) {}
        }
    });

    test('uploaded pfp bytes survive a server restart', async ({ browser, request }) => {
        test.setTimeout(180000);
        const ts = Date.now().toString(36);
        const userA = 'rp_a_' + ts;
        const png = makePng();

        // Phase 1: register A, upload pfp, save profile.
        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const body1 = await registerUser(page1, userA);
        expect(body1.token).toBeTruthy();

        const fileId: string = await page1.evaluate(async ({ pngBase64 }) => {
            const init = await fetch('/api/files/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ size: (Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0))).length, mime: 'image/png' }),
            });
            const { file_id } = await init.json();
            const rawBytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
            const fileKey = E2ECrypto.generateFileKey();
            const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes);
            const blob = new Blob([encrypted], { type: 'application/octet-stream' });
            await fetch(`/api/files/${file_id}/chunk/0`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: blob,
            });
            await fetch(`/api/files/${file_id}/complete`, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            (window as any).profilePfpFileId = file_id;
            (window as any).profilePfpFileKey = E2ECrypto.arrayBufferToBase64(fileKey);
            (window as any)._removePfpFlag = false;
            await (window as any).saveProfile();
            return file_id;
        }, { pngBase64: png.toString('base64') });
        expect(fileId).toBeTruthy();
        await page1.waitForTimeout(1000);

        // Sanity: file downloadable before restart.
        const dlBefore = await page1.request.get(`${ALT}/api/files/${fileId}/download`, {
            headers: { Authorization: 'Bearer ' + body1.token },
        });
        expect(dlBefore.status()).toBe(200);
        const bytesBefore = Buffer.from(await dlBefore.body());
        expect(bytesBefore.length).toBeGreaterThan(50);

        // Record the on-disk dir exists (the isolated server uses its own
        // uploads dir next to the temp DB).
        const serverDir = path.join(__dirname, '..', 'server');
        const diskDir = path.join(serverDir, 'uploads');
        const uploadsRoot = fs.existsSync(tmpDb + '-uploads') ? tmpDb + '-uploads' : diskDir;
        const fileDiskDir = path.join(uploadsRoot, fileId);
        expect(fs.existsSync(fileDiskDir), 'upload dir exists before restart').toBe(true);

        await ctx1.close();

        // Phase 2: kill server, restart with the SAME database.
        child.kill();
        await new Promise((r) => setTimeout(r, 1200));
        await startServer(request);

        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await loginUser(page2, userA);

        // File bytes must still be served.
        const dlAfter = await page2.request.get(`${ALT}/api/files/${fileId}/download`, {
            headers: { Authorization: 'Bearer ' + body2.token },
        });
        expect(dlAfter.status(), 'download after restart').toBe(200);
        const bytesAfter = Buffer.from(await dlAfter.body());
        expect(bytesAfter.length).toBe(bytesBefore.length);

        // On-disk dir must survive.
        expect(fs.existsSync(fileDiskDir), 'upload dir exists after restart').toBe(true);

        // By-hash lookup (the client's PFP path) must still resolve.
        const hash = await page2.evaluate((fid: string) => E2ECrypto.sha256Hex(fid), fileId);
        const byHash = await page2.request.get(`${ALT}/api/files/by-hash/${hash}/download`, {
            headers: { Authorization: 'Bearer ' + body2.token },
        });
        expect(byHash.status(), 'by-hash download after restart').toBe(200);
        const bytesByHash = Buffer.from(await byHash.body());
        expect(bytesByHash.length).toBe(bytesBefore.length);

        await ctx2.close();
    });
});
