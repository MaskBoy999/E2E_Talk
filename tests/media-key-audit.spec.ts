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

// Set a PFP through the REAL UI flow so module-scope globals are populated.
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

async function corruptMediaCaches(page: Page, picFileId: string) {
    await page.evaluate((fid) => {
        // Simulate wrong-key ciphertext: values that start with the secure-storage
        // magic byte '~' are exactly what the interceptor leaks when it can't
        // decrypt an entry, and what consumers mistake for a valid key.
        localStorage.setItem('fkc_' + fid, '~GARBAGE_WRONG_KEY_CIPHERTEXT');
        localStorage.setItem('fkc_00000000deadbeef00000000deadbeef00000000deadbeef00000000deadbeef', '~MORE_WRONG_KEY_CIPHERTEXT');
        localStorage.setItem('profile_key_cache', '~WRONG_KEY_PROFILE_CACHE');
    }, picFileId);
}

test.describe('Boot-time media-key cache audit', () => {
    test.setTimeout(180000);

    test('unreadable fkc_/profile_key_cache entries are dropped at boot and the profile pic key is repaired', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'mka_a_' + ts;
        const userB = 'mka_b_' + ts;

        const ctxA: BrowserContext = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB: BrowserContext = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);

        // A sets a PFP; B must receive the pic key through the live path.
        const picFileId = await setPfp(pageA, makePng());
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await pageA.waitForTimeout(2500);

        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const avatar = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(avatar).toBeVisible({ timeout: 20000 });
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);

        // Corrupt the media caches with wrong-key ciphertext (silent-break state).
        await corruptMediaCaches(pageB, picFileId);
        // Prove the corruption is "live": getItem now returns the garbage the
        // consumers would have treated as a valid key.
        expect(await pageB.evaluate((fid) => localStorage.getItem('fkc_' + fid), picFileId)).toContain('~');
        expect(await pageB.evaluate(() => localStorage.getItem('profile_key_cache'))).toContain('~');

        // Reload B — the boot-time audit must run before anything renders.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('#dm-strip-btn', { timeout: 15000 });
        await pageB.waitForTimeout(1000);

        // Unknown-file garbage (no owner) is dropped outright.
        expect(await pageB.evaluate(() => localStorage.getItem('fkc_00000000deadbeef00000000deadbeef00000000deadbeef00000000deadbeef'))).toBeNull();
        // profile_key_cache is a readable JSON object again, never '~' garbage.
        const pkc = await pageB.evaluate(() => {
            const v = localStorage.getItem('profile_key_cache');
            if (!v || v.charAt(0) === '~') return null;
            try { return JSON.parse(v); } catch (_) { return null; }
        });
        expect(pkc, 'profile_key_cache is valid JSON after the audit').not.toBeNull();

        // The profile pic key is repaired (either from the display-name cache
        // directly at boot, or via the queued server re-derivation) — it must
        // become a plausible base64 key, never '~'-prefixed garbage.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => {
                const v = localStorage.getItem('fkc_' + fid);
                return v !== null && v.charAt(0) !== '~' && /^[A-Za-z0-9+/=:]+$/.test(v);
            }, picFileId);
        }, { timeout: 20000 }).toBe(true);

        // And the avatar actually renders again — nothing stayed broken silently.
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const avatar2 = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(avatar2).toBeVisible({ timeout: 20000 });
        expect((await avatar2.getAttribute('src')) || '').toContain('blob:');

        await ctxA.close();
        await ctxB.close();
    });

    test('the audit repairs fkc_ from the display-name cache without waiting for a re-render', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'mka_d_a_' + ts;
        const userB = 'mka_d_b_' + ts;

        const ctxA: BrowserContext = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB: BrowserContext = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);
        const picFileId = await setPfp(pageA, makePng(30, 200, 90));
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await pageA.waitForTimeout(2500);

        // B sees the avatar and caches the key.
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        await expect(pageB.locator('.dm-item').first().locator('.dm-avatar img')).toBeVisible({ timeout: 20000 });
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);
        // The display-name cache must have persisted the raw pic key (that's what
        // the audit restores from synchronously at boot).
        const dn = await pageB.evaluate(() => localStorage.getItem('user_display_name_cache'));
        expect(dn, 'display-name cache persisted').toBeTruthy();

        // Corrupt only the fkc_ entry, then reload WITHOUT opening the DM again.
        await pageB.evaluate((fid) => {
            localStorage.setItem('fkc_' + fid, '~WRONG_KEY_CIPHERTEXT');
        }, picFileId);
        expect(await pageB.evaluate((fid) => localStorage.getItem('fkc_' + fid), picFileId)).toContain('~');

        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('#dm-strip-btn', { timeout: 15000 });

        // The key is repaired without any DM interaction: either the audit's
        // direct display-name-cache restore (synchronous at boot) or the queued
        // server re-derivation. The contract: no '~' garbage, plausible key.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => {
                const v = localStorage.getItem('fkc_' + fid);
                return v !== null && v.charAt(0) !== '~' && /^[A-Za-z0-9+/=:]+$/.test(v);
            }, picFileId);
        }, { timeout: 20000 }).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });
});
