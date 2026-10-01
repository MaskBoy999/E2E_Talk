import { test, expect, Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

// A profile picture is now uploaded twice: the original, plus a 360x360 preview
// that is encrypted with its own random key and stored in its own columns. Every
// avatar renders from the preview; only the profile view pulls the original.
// These tests cover the client-side generation/upload, the server contract, and
// the recipient side (a DM peer must download the preview, not the original).

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    const body = await page.evaluate(() => ({
        token: localStorage.getItem('token') as string,
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
    expect(body.token).toBeTruthy();
    return body;
}

async function becomeFriends(page1: Page, page2: Page, token1: string, token2: string) {
    const code2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: code2 },
    });
    expect(fr.ok()).toBeTruthy();
    await page2.waitForTimeout(800);
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(incoming.length).toBeGreaterThan(0);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
    await page1.waitForTimeout(800);
}

// A distinctive image of the requested size, as base64 PNG.
async function makePng(page: Page, size: number): Promise<string> {
    return page.evaluate((s: number) => {
        const c = document.createElement('canvas');
        c.width = s;
        c.height = s;
        const ctx = c.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, s, s);
        g.addColorStop(0, '#e91e63');
        g.addColorStop(0.5, '#4fc3f7');
        g.addColorStop(1, '#101010');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        return c.toDataURL('image/png').split(',')[1];
    }, size);
}

// Upload one complete encrypted file through the same chunk protocol the client
// uses, returning its id and its raw base64 file key.
async function uploadEncrypted(page: Page, pngBase64: string): Promise<{ id: string; key: string }> {
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const raw = Buffer.from(pngBase64, 'base64');
    const initRes = await page.request.post(`${BASE}/api/files/init`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { size: raw.length, mime: 'image/png' },
    });
    expect(initRes.ok()).toBeTruthy();
    const { file_id } = await initRes.json();
    const key = await page.evaluate(async ({ fileId, b64 }) => {
        const rawBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fileKey = E2ECrypto.generateFileKey();
        const keyB64 = E2ECrypto.arrayBufferToBase64(fileKey);
        // The chunk index is mandatory: the two-argument form does not produce a
        // chunk that decryptFileChunk(…, …, 0) can read back.
        const encrypted = E2ECrypto.encryptFileChunk(fileKey, rawBytes, 0);
        await fetch(`/api/files/${fileId}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: new Blob([encrypted], { type: 'application/octet-stream' }),
        });
        await fetch(`/api/files/${fileId}/complete`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        fileKeyCache.set(fileId, keyB64);
        return keyB64;
    }, { fileId: file_id, b64: pngBase64 });
    return { id: file_id, key };
}

// Decrypt a stored profile file in the page and report its pixel size.
async function decryptDims(page: Page, fileId: string) {
    return page.evaluate(async (id: string) => {
        const keyB64 = localStorage.getItem('fkc_' + id);
        const res = await fetch(`/api/files/${id}/download`, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        if (!res.ok) return { error: 'HTTP ' + res.status };
        const data = new Uint8Array(await res.arrayBuffer());
        const dec = await decryptProfilePicData(new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64!)), data);
        if (!dec) return { error: 'decrypt failed' };
        const bmp = await createImageBitmap(new Blob([dec], { type: 'image/png' }));
        const out = { w: bmp.width, h: bmp.height, bytes: dec.length };
        bmp.close();
        return out;
    }, fileId);
}

test.describe('Profile picture thumbnails (360x360)', () => {
    test.setTimeout(150000);

    test('the server stores the preview next to the picture, and drops it with the picture', async ({ page, context }) => {
        const ts = Date.now();
        const body = await registerUser(page, 'pfpth1_' + ts);
        const full = await uploadEncrypted(page, await makePng(page, 512));
        const preview = await uploadEncrypted(page, await makePng(page, 360));

        const auth = { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' };
        const patch = await page.request.patch(`${BASE}/api/profile`, {
            headers: auth,
            data: {
                profile_picture_file_id: full.id,
                encrypted_pic_key: Buffer.from('picture-key-ciphertext').toString('base64'),
                pic_key_nonce: Buffer.from('picture-nonce-1').toString('base64'),
                profile_picture_thumb_file_id: preview.id,
                encrypted_pic_thumb_key: Buffer.from('preview-key-ciphertext').toString('base64'),
                pic_thumb_key_nonce: Buffer.from('preview-nonce-1').toString('base64'),
            },
        });
        expect(patch.ok()).toBeTruthy();

        let prof = await (await page.request.get(`${BASE}/api/profile/${body.user.id}`, { headers: auth })).json();
        expect(prof.profile_picture_file_id).toBe(full.id);
        expect(prof.profile_picture_thumb_file_id).toBe(preview.id);
        expect(prof.profile_picture_thumb_file_id_hash).toBeTruthy();
        expect(prof.profile_picture_thumb_file_id_hash).not.toBe(prof.profile_picture_file_id);
        expect(prof.encrypted_pic_thumb_key).toBeTruthy();
        expect(prof.pic_thumb_key_nonce).toBeTruthy();
        // The preview's own key is a different ciphertext than the picture's.
        expect(prof.encrypted_pic_thumb_key).not.toBe(prof.encrypted_pic_key);

        // Downloadable by its blind hash, exactly like the picture.
        const byHash = await page.request.get(`${BASE}/api/files/by-hash/${prof.profile_picture_thumb_file_id_hash}/download`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(byHash.status()).toBe(200);

        // Someone else's file cannot be claimed as a preview.
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const other = await registerUser(page2, 'pfpth1b_' + ts);
        const theirFile = await uploadEncrypted(page2, await makePng(page2, 200));
        const bad = await page.request.patch(`${BASE}/api/profile`, {
            headers: auth,
            data: { profile_picture_thumb_file_id: theirFile.id },
        });
        expect(bad.status()).toBe(403);
        await page2.close();
        await ctx2.close();

        // Removing the picture removes the preview with it.
        const removed = await page.request.patch(`${BASE}/api/profile`, { headers: auth, data: { remove_picture: true } });
        expect(removed.ok()).toBeTruthy();
        prof = await (await page.request.get(`${BASE}/api/profile/${body.user.id}`, { headers: auth })).json();
        expect(prof.profile_picture_file_id).toBeNull();
        expect(prof.profile_picture_thumb_file_id).toBeNull();
        expect(prof.profile_picture_thumb_file_id_hash).toBeNull();
        expect(prof.encrypted_pic_thumb_key).toBeNull();
        expect(prof.pic_thumb_key_nonce).toBeNull();
    });

    test('the crop flow uploads a 360px preview alongside the original', async ({ page }) => {
        const ts = Date.now();
        const body = await registerUser(page, 'pfpth2_' + ts);
        const source = await makePng(page, 700);

        // Open the edit modal for real: the crop UI lives inside it, and its
        // frame has no layout while the modal is hidden.
        await page.click('#footer-user-avatar');
        await page.waitForTimeout(2000);
        await page.click('#profile-edit-btn');
        await page.waitForTimeout(500);

        // Drive the real crop confirm with a 700x700 source: it must upload the
        // original AND a 360x360 preview with its own key.
        const uploaded = await page.evaluate(async (b64: string) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            openPfpCrop(new File([bytes], 'avatar.png', { type: 'image/png' }));
            for (let i = 0; i < 100 && !pfpCropState; i++) await new Promise((r) => setTimeout(r, 50));
            if (!pfpCropState) return { error: 'crop never armed' };
            await processPfpCrop();
            return {
                fullId: profilePfpFileId,
                fullKey: profilePfpFileKey,
                previewId: profilePfpThumbFileId,
                previewKey: profilePfpThumbFileKey,
            };
        }, source);
        expect(uploaded.error).toBeUndefined();
        expect(uploaded.fullId).toBeTruthy();
        expect(uploaded.previewId).toBeTruthy();
        expect(uploaded.previewId).not.toBe(uploaded.fullId);
        expect(uploaded.previewKey).toBeTruthy();
        expect(uploaded.previewKey).not.toBe(uploaded.fullKey);

        const fullDims = await decryptDims(page, uploaded.fullId!);
        const previewDims = await decryptDims(page, uploaded.previewId!);
        expect(fullDims.error).toBeUndefined();
        expect(previewDims.error).toBeUndefined();
        // The crop confirm uploads the square the user selected (the crop UI
        // starts at a centered 70% square), untouched.
        expect(fullDims.w).toBe(fullDims.h);
        expect(fullDims.w!).toBeGreaterThan(360);
        expect(fullDims.w!).toBeLessThanOrEqual(700);
        expect(previewDims.w).toBe(360);
        expect(previewDims.h).toBe(360);
        expect(previewDims.bytes!).toBeLessThan(fullDims.bytes!);

        // Watch every profile-file download from here on: the save re-renders the
        // profile view, which is the ONE place the original is the right file.
        const requests: string[] = [];
        await page.route('**/api/files/**', async (route) => {
            requests.push(route.request().url());
            await route.continue();
        });

        // Saving the profile publishes both ids.
        const status = await page.evaluate(async () => {
            const el = document.getElementById('profile-edit-status');
            await (saveProfile as any)();
            return el ? (el.textContent || '') : '';
        });
        expect(status).toContain('Profile saved');

        const auth = { Authorization: `Bearer ${body.token}` };
        const prof = await (await page.request.get(`${BASE}/api/profile/${body.user.id}`, { headers: auth })).json();
        expect(prof.profile_picture_file_id).toBe(uploaded.fullId);
        expect(prof.profile_picture_thumb_file_id).toBe(uploaded.previewId);
        expect(prof.encrypted_pic_thumb_key).toBeTruthy();

        // The profile view still renders the ORIGINAL: it is the one place a
        // full-size image is the right file (a 288px avatar on a retina screen).
        await page.waitForTimeout(2500);
        const modalImgs = await page.locator('#profile-modal-avatar img').count();
        expect(modalImgs).toBeGreaterThan(0);
        expect(requests.some((u) => u.includes(uploaded.fullId!))).toBe(true);
        await page.click('#profile-modal-close');
    });

    test('a DM recipient renders the avatar from the preview, not the original', async ({ page, context }) => {
        const ts = Date.now();
        const body1 = await registerUser(page, 'pfpth3a_' + ts);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, 'pfpth3b_' + ts);

        await becomeFriends(page, page2, body1.token, body2.token);

        // User 1 starts the DM, then reloads so the conversation — and the DM key
        // — is in its client before the profile save uploads the shared blob.
        const dm = await page.request.post(`${BASE}/api/dm/${body2.user.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        expect(dm.ok()).toBeTruthy();
        const dmChannelId = (await dm.json()).id;
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2500);

        const full = await uploadEncrypted(page, await makePng(page, 640));
        const preview = await uploadEncrypted(page, await makePng(page, 256));
        const status = await page.evaluate(async ({ fullId, fullKey, previewId, previewKey }) => {
            (profilePfpFileId as any) = fullId;
            (profilePfpFileKey as any) = fullKey;
            (profilePfpThumbFileId as any) = previewId;
            (profilePfpThumbFileKey as any) = previewKey;
            (_removePfpFlag as any) = false;
            const el = document.getElementById('profile-edit-status');
            await (saveProfile as any)();
            return el ? (el.textContent || '') : '';
        }, { fullId: full.id, fullKey: full.key, previewId: preview.id, previewKey: preview.key });
        expect(status).toContain('Profile saved');

        // The recipient learns the preview (id + raw key) from the DM profile blob.
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        const validated = await page2.evaluate(async ({ ownerId, chanId }) => {
            await fetchDmConversationProfile(ownerId, chanId);
            const entry = userDisplayNameCache[ownerId] || {};
            return {
                previewId: entry.profile_picture_thumb_file_id || null,
                hasKey: !!entry.profile_picture_thumb_file_key,
            };
        }, { ownerId: body1.user.id, chanId: dmChannelId });
        expect(validated.previewId).toBe(preview.id);
        expect(validated.hasKey).toBe(true);

        // The render resolves the owner's picture id to the preview: watch the
        // file requests of one fresh render. Everything before this point may
        // still have pulled the original — that is the pre-key path, unchanged.
        const downloads: string[] = [];
        await page2.route('**/api/files/**', async (route) => {
            downloads.push(route.request().url());
            await route.continue();
        });
        await page2.evaluate(({ ownerId, fullId }) => {
            delete profilePicCache[ownerId + ':' + fullId];
        }, { ownerId: body1.user.id, fullId: full.id });
        downloads.length = 0;
        await page2.evaluate(({ ownerId, fullId }) => {
            getProfilePicUrl(fullId, ownerId);
        }, { ownerId: body1.user.id, fullId: full.id });
        await expect.poll(async () => page2.evaluate(({ ownerId, fullId }) => {
            return !!profilePicCache[ownerId + ':' + fullId];
        }, { ownerId: body1.user.id, fullId: full.id }), { timeout: 20000 }).toBe(true);

        // The avatar is now a decoded blob (keyed by the ORIGINAL id, so every
        // render site keeps working) and the bytes came from the preview.
        const decoded = await page2.evaluate(({ ownerId, fullId }) => profilePicCache[ownerId + ':' + fullId], {
            ownerId: body1.user.id,
            fullId: full.id,
        });
        expect(String(decoded).startsWith('blob:')).toBe(true);
        expect(downloads.some((u) => u.includes(preview.id))).toBe(true);
        expect(downloads.some((u) => u.includes(full.id))).toBe(false);

        await page2.close();
        await ctx2.close();
    });
});
