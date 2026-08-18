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

// Upload a PFP through the REAL UI flow: settings → open profile → edit →
// choose image → crop confirm → save. This sets the module-scope
// profilePfpFileId/Key globals properly (the window-assignment shortcut the
// old helper used never reached the module-scope `let`, so saveProfile()
// silently PATCHed without the pic — that's why the old probe always
// returned null).
async function setPfp(page: Page, png: Buffer): Promise<string> {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-modal[style*="flex"]', { timeout: 10000 }).catch(() => {});
    // Settings modal may be display:flex via a class; just click the open-profile button.
    await page.click('#settings-open-profile-btn', { timeout: 10000 });
    await page.waitForSelector('#profile-modal[style*="flex"]', { timeout: 10000 });
    // Own profile shows the edit button; wait for it to appear (profile fetch + decrypt).
    await page.waitForSelector('#profile-edit-btn', { state: 'visible', timeout: 15000 });
    await page.click('#profile-edit-btn');
    await page.waitForSelector('#profile-edit-modal[style*="flex"]', { timeout: 10000 });
    // Choose the image file (triggers the change handler → openPfpCrop).
    await page.setInputFiles('#profile-avatar-file-input', {
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: png,
    });
    await page.waitForSelector('#profile-pfp-crop-container', { state: 'visible', timeout: 10000 });
    await page.click('#profile-pfp-crop-confirm');
    // processPfpCrop uploads + sets the module-scope globals, then hides the crop UI.
    await page.waitForSelector('#profile-pfp-crop-container', { state: 'hidden', timeout: 20000 });
    await page.waitForTimeout(500);
    await page.click('#profile-edit-save-btn');
    await expect(page.locator('#profile-edit-status')).toContainText('Profile saved!', { timeout: 20000 });
    // saveProfile schedules broadcastProfileKeySyncToAllDms on a 500ms timer;
    // stay on the page so the WS sync actually reaches the other user before
    // the test navigates A away (otherwise profile_key_cache never populates).
    await page.waitForTimeout(2500);
    // Read the stored file id back from the own-profile API.
    const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
    const prof = await (await page.request.get(`${BASE}/api/profile/${uid}`, {
        headers: { Authorization: 'Bearer ' + (await page.evaluate(() => localStorage.getItem('token'))) },
    })).json();
    expect(prof.profile_picture_file_id, 'PFP must actually be stored server-side').toBeTruthy();
    return prof.profile_picture_file_id as string;
}

test.describe('Media-key recovery after localStorage eviction', () => {
    test.setTimeout(180000);

    test('B sees A\'s avatar after A sets a pfp, then recovers it from the server after B\'s media caches are wiped', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'mkr_a_' + ts;
        const userB = 'mkr_b_' + ts;

        const ctxA: BrowserContext = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB: BrowserContext = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);

        // A uploads a PFP and saves the profile (encrypted pic key to A's identity).
        const picFileId = await setPfp(pageA, makePng());

        // Reload A so myProfile is loaded, then open A's DM list: loadDmConversations
        // + loadMyProfile both fire the WS profile_key_sync broadcast to B with the
        // pic key (decrypted with the DM key). Without this, A's client never
        // learns about the DM (the friendship was made via API) and never sends.
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await pageA.click('#dm-strip-btn');
        await pageA.waitForSelector('.dm-item', { timeout: 10000 });
        await pageA.waitForTimeout(2500);

        // The undefined scheduleProfileKeySave() used to abort its callers; it
        // must now exist (and be defined before any call site runs).
        expect(await pageB.evaluate(() => typeof (window as any).scheduleProfileKeySave)).toBe('function');
        expect(await pageA.evaluate(() => typeof (window as any).scheduleProfileKeySave)).toBe('function');

        // B opens the DM list and A's avatar must render as an image.
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const dmAvatarImg = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(dmAvatarImg).toBeVisible({ timeout: 20000 });
        const srcBefore = await dmAvatarImg.getAttribute('src');
        expect(srcBefore || '').toContain('blob:');

        // The fkc_* media cache must hold the pic key — written by the
        // conversation-profile fetch (prefetchDmConversationProfiles) and by
        // getProfilePicUrl's recovery path. This is the cache that actually
        // survives the eviction simulation below.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);
        // And the display-name cache persisted too (same write path).
        await expect.poll(async () => {
            return await pageB.evaluate(() => {
                try { return (localStorage.getItem('user_display_name_cache') || '').length; } catch (_) { return 0; }
            });
        }, { timeout: 10000 }).toBeGreaterThan(2);

        // ---- Simulate mobile-browser localStorage eviction of the media caches
        // (keep the token, identity keys, device keys — only the decryption-key
        // caches are dropped, exactly like a storage-pressure eviction).
        await pageB.evaluate(() => {
            const keep = (k: string) => !k.startsWith('fkc_') && k !== 'user_display_name_cache' && k !== 'profile_key_cache';
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && !keep(k)) keys.push(k);
            }
            keys.forEach((k) => localStorage.removeItem(k));
        });
        expect(await pageB.evaluate(() => localStorage.getItem('profile_key_cache'))).toBeNull();
        expect(await pageB.evaluate((fid) => localStorage.getItem('fkc_' + fid), picFileId)).toBeNull();

        // Reload B: fresh JS state, empty caches — the avatar must self-heal by
        // re-deriving the pic key from the server conversation profile.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('#dm-strip-btn', { timeout: 15000 });
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        const dmAvatarImg2 = pageB.locator('.dm-item').first().locator('.dm-avatar img');
        await expect(dmAvatarImg2).toBeVisible({ timeout: 25000 });
        const srcAfter = await dmAvatarImg2.getAttribute('src');
        expect(srcAfter || '').toContain('blob:');

        // The recovery repopulates the preserved fkc_* bucket so the next page
        // load doesn't need the server again.
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 15000 }).toBe(true);

        await ctxA.close();
        await ctxB.close();
    });

    test('profile_key_cache survives the login-page wipe (forced re-login)', async ({ browser }) => {
        const ts = Date.now().toString(36);
        const userA = 'mkr_w_a_' + ts;
        const userB = 'mkr_w_b_' + ts;

        const ctxA: BrowserContext = await browser.newContext();
        const pageA = await ctxA.newPage();
        const aInfo = await registerUser(pageA, userA);

        const ctxB: BrowserContext = await browser.newContext();
        const pageB = await ctxB.newPage();
        const bInfo = await registerUser(pageB, userB);

        await becomeFriendsViaApi(pageA, pageB, aInfo.token, bInfo.token);
        await setPfp(pageA, makePng(30, 200, 90));
        await pageA.goto(`${BASE}/index.html`);
        await pageA.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await pageA.waitForTimeout(3000);

        // B opens DM view so the pic key arrives and is persisted.
        await pageB.click('#dm-strip-btn');
        await pageB.waitForSelector('.dm-item', { timeout: 10000 });
        await expect(pageB.locator('.dm-item').first().locator('.dm-avatar img')).toBeVisible({ timeout: 20000 });
        const picFileId = await pageA.evaluate(() => {
            try { return JSON.parse(localStorage.getItem('user') || '{}').id; } catch (_) { return null; }
        }).then(async (uid) => {
            const prof = await (await pageA.request.get(`${BASE}/api/profile/${uid}`, {
                headers: { Authorization: 'Bearer ' + (await pageA.evaluate(() => localStorage.getItem('token'))) },
            })).json();
            return prof.profile_picture_file_id as string;
        });
        // The key must land in the fkc_* media cache (conversation-profile path).
        await expect.poll(async () => {
            return await pageB.evaluate((fid) => !!localStorage.getItem('fkc_' + fid), picFileId);
        }, { timeout: 10000 }).toBe(true);
        // And the display-name cache persisted too.
        await expect.poll(async () => {
            return await pageB.evaluate(() => {
                try { return (localStorage.getItem('user_display_name_cache') || '').length; } catch (_) { return 0; }
            });
        }, { timeout: 10000 }).toBeGreaterThan(2);

        // Ensure profile_key_cache actually exists before the wipe. In a pure DM
        // flow the WS profile_key_sync handler that populates profileKeyCache is
        // server-dropped (the live path is profile_updated → conversation
        // profile → fkc_*), so seed it through the app's own persistence
        // mechanism — scheduleProfileKeySave is exactly what every profile-key
        // derivation calls — then verify it landed, so this test exercises the
        // wipe-preservation contract rather than asserting on a key that was
        // never written.
        await pageB.evaluate(() => {
            const pkc: Record<string, string> = (window as any).profileKeyCache || {};
            pkc['seed_user:profile_data_key'] = 'seedvalue';
            (window as any).profileKeyCache = pkc;
            (window as any).scheduleProfileKeySave();
        });
        await pageB.waitForTimeout(1200);
        const pkcBefore = await pageB.evaluate(() => localStorage.getItem('profile_key_cache'));
        expect(pkcBefore, 'profile_key_cache was persisted before the wipe').toBeTruthy();

        // Simulate an expired/revoked session: no token → the next visit to the
        // login page runs wipeAllClientData. The media caches must survive.
        await pageB.evaluate(() => localStorage.removeItem('token'));
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForSelector('#show-register', { timeout: 15000 });
        // fkc_* bucket survives the wipe (existing behavior kept).
        const fkcCount = await pageB.evaluate(() => {
            let n = 0;
            for (let i = 0; i < localStorage.length; i++) {
                if (localStorage.key(i) && localStorage.key(i)!.startsWith('fkc_')) n++;
            }
            return n;
        });
        expect(fkcCount).toBeGreaterThanOrEqual(1);
        // The pic key entry specifically survived.
        expect(await pageB.evaluate((fid) => localStorage.getItem('fkc_' + fid), picFileId)).toBeTruthy();
        // The display-name cache survives too.
        const dnSaved = await pageB.evaluate(() => localStorage.getItem('user_display_name_cache'));
        expect(dnSaved, 'user_display_name_cache survives the login wipe').toBeTruthy();
        // profile_key_cache is preserved as well (may be an empty {} in a pure
        // DM flow — the important thing is it's not corrupted/removed so any
        // server-key entries written later are kept).
        const pkcSaved = await pageB.evaluate(() => localStorage.getItem('profile_key_cache'));
        expect(pkcSaved, 'profile_key_cache key survives the login wipe').not.toBeNull();

        await ctxA.close();
        await ctxB.close();
    });
});
