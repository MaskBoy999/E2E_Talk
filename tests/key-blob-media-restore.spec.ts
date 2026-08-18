import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';

function makePng(r = 120, g = 80, b = 200): Buffer {
    const zlib = require('zlib');
    const w = 4, h = 4;
    const raw = Buffer.alloc(1 + w * h * 3);
    raw[0] = 0;
    for (let i = 1; i < raw.length; i++) { raw[i] = (i % 2 === 0) ? r : g; }
    function crc32(buf: Buffer): Buffer {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
        c = (c ^ 0xffffffff) >>> 0; const out = Buffer.alloc(4); out.writeUInt32BE(c); return out;
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
    await page.goto(`${BASE}/login.html`);
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

async function becomeFriendsViaApi(page1: Page, page2: Page, token1: string, token2: string) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function setPfp(page: Page, png: Buffer): Promise<string> {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal[style*="flex"]', { timeout: 10000 }).catch(() => {});
    await page.click('#settings-open-profile-btn', { timeout: 10000 });
    await page.waitForSelector('#profile-modal[style*="flex"]', { timeout: 10000 });
    await page.waitForSelector('#profile-edit-btn', { state: 'visible', timeout: 15000 });
    await page.click('#profile-edit-btn');
    await page.waitForSelector('#profile-edit-modal[style*="flex"]', { timeout: 10000 });
    await page.setInputFiles('#profile-avatar-file-input', { name: 'avatar.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#profile-pfp-crop-container', { state: 'visible', timeout: 10000 });
    await page.click('#profile-pfp-crop-confirm');
    await page.waitForSelector('#profile-pfp-crop-container', { state: 'hidden', timeout: 20000 });
    await page.waitForTimeout(500);
    await page.click('#profile-edit-save-btn');
    await expect(page.locator('#profile-edit-status')).toContainText('Profile saved!', { timeout: 20000 });
    await page.waitForTimeout(2500);
    const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
    const prof = await (await page.request.get(`${BASE}/api/profile/${uid}`, {
        headers: { Authorization: 'Bearer ' + (await page.evaluate(() => localStorage.getItem('token'))) },
    })).json();
    expect(prof.profile_picture_file_id, 'PFP must actually be stored server-side').toBeTruthy();
    return prof.profile_picture_file_id as string;
}

// Decrypt B's server key-blob and return the restored bundle keys (proves the
// media caches actually made it into the blob before the wipe).
async function decryptStoredBlob(page: Page, token: string, password: string): Promise<Record<string, unknown>> {
    return await page.evaluate(async ({ token, password }) => {
        const res = await fetch('/api/key-blob', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.encrypted_blob || !data.salt || !data.nonce) return null;
        const bundle = E2ECrypto.decryptKeyBundle(data.encrypted_blob, password, data.salt, data.nonce);
        return bundle;
    }, { token, password });
}

test.describe('Key-blob restore after a complete localStorage clear (new device)', () => {
    test.setTimeout(180000);

    test('identity keys + media caches (fkc_, display-name cache, profile_key_cache) restore from the server blob', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'kbr_a_' + ts;
        const userB = 'kbr_b_' + ts;
        const password = 'password123';

        const ctxA: BrowserContext = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB: BrowserContext = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);
        expect(bInfo.token).toBeTruthy();

        await becomeFriendsViaApi(pageA, pageB, aInfo.token!, bInfo.token!);

        // A sets a PFP; B's media caches fill when B sees the avatar.
        const picFileId = await setPfp(pageA, makePng());
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await pageA.waitForTimeout(2500);

        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const avatar = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(avatar).toBeVisible({ timeout: 20000 });
        // fkc_ media cache + display-name cache are populated on B.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);
        const dn = await pageB.evaluate(() => localStorage.getItem('user_display_name_cache'));
        expect(dn, 'display-name cache populated').toBeTruthy();

        // The media caches must have been pushed into the server key-blob by the
        // debounced blob refresh (scheduleKeyBlobSave on cache writes). Poll the
        // stored blob until it contains both the pic key and the display-name cache.
        await expect.poll(async () => {
            const bundle = await decryptStoredBlob(pageB, bInfo.token!, password);
            if (!bundle) return false;
            return !!bundle['fkc_' + picFileId] && typeof bundle['user_display_name_cache'] === 'string';
        }, { timeout: 20000 }).toBe(true);

        // Capture a bit more cache state for the restore assertions.
        const dnHasA = await pageB.evaluate((uname) => {
            try {
                const dnCache = JSON.parse(localStorage.getItem('user_display_name_cache') || '{}');
                return Object.keys(dnCache).length > 0;
            } catch (_) { return false; }
        }, userA);

        // ---- Simulate a brand-new device: COMPLETELY clear this context ----
        await pageB.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
        expect(await pageB.evaluate(() => !!localStorage.getItem('token'))).toBe(false);
        expect(await pageB.evaluate(() => E2ECrypto.getIdentityKeyPair() === null)).toBe(true);

        // Log back in on the "new device" — completeLogin restores the blob.
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForSelector('#login-username', { timeout: 15000 });
        await pageB.fill('#login-username', userB);
        await pageB.fill('#login-password', password);
        await pageB.click('#login-form button[type="submit"]');
        await pageB.waitForURL('**/index.html', { timeout: 25000 });
        await pageB.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });

        // Identity keys restored.
        expect(await pageB.evaluate(() => E2ECrypto.getIdentityKeyPair() !== null)).toBe(true);

        // Media caches restored from the blob (not re-derived — instant).
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);
        const dnAfter = await pageB.evaluate(() => localStorage.getItem('user_display_name_cache'));
        expect(dnAfter, 'display-name cache restored from the blob').toBeTruthy();
        if (dnHasA) expect(dnAfter!.length).toBeGreaterThan(2);
        const pkcAfter = await pageB.evaluate(() => {
            const v = localStorage.getItem('profile_key_cache');
            if (!v || v.charAt(0) === '~') return null;
            try { return JSON.parse(v); } catch (_) { return null; }
        });
        expect(pkcAfter, 'profile_key_cache restored as valid JSON').not.toBeNull();

        // The avatar renders immediately from the restored media cache.
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const avatar2 = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(avatar2).toBeVisible({ timeout: 20000 });
        expect((await avatar2.getAttribute('src')) || '').toContain('blob:');

        await ctxA.close();
        await ctxB.close();
    });
});
