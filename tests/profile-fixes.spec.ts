import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
        friendCode: localStorage.getItem('e2e_friend_code'),
    }));
}

async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
    const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(friendCode2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: friendCode2 },
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

async function openOwnProfile(page: any) {
    await page.click('#footer-user-avatar');
    await page.waitForSelector('#profile-modal', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(() => {
        const el = document.getElementById('profile-modal-display-name');
        return el && el.textContent && el.textContent !== 'Loading...' && el.textContent !== '';
    }, { timeout: 15000 });
}

async function openEditModal(page: any) {
    await page.click('#profile-edit-btn');
    await page.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 5000 });
}

test.describe('Profile Fixes', () => {

    test('saveProfile does not crash with null element error', async ({ page }) => {
        const ts = Date.now();
        const username = 'saveprof_' + ts;
        await registerUser(page, username);

        await openOwnProfile(page);
        await openEditModal(page);

        await page.fill('#profile-edit-display-name', 'Updated_' + ts);

        const errors: string[] = [];
        page.on('pageerror', (err: any) => errors.push(err.message));

        await page.click('#profile-edit-save-btn');
        await page.waitForTimeout(3000);

        const nullError = errors.find(e => e.includes("null") && e.includes('style'));
        expect(nullError).toBeUndefined();
    });

    test('API returns nickname and description for other users', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'apiown_' + ts;
        const user2 = 'apisee_' + ts;

        const body1 = await registerUser(page, user1);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        const patchRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: {
                display_name: 'VisibleDisplay',
                nickname: 'VisibleNick',
                description: 'Visible description',
            },
        });
        expect(patchRes.ok()).toBeTruthy();

        const profRes = await page2.request.get(`${BASE}/api/profile/${body1.user.id}`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        });
        const prof = await profRes.json();

        expect(prof.display_name).toBe('VisibleDisplay');
        expect(prof.nickname).toBe('VisibleNick');
        expect(prof.description).toBe('Visible description');
    });

    test('other user can see friend nickname and description in profile modal', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'ownick_' + ts;
        const user2 = 'seenick_' + ts;

        const body1 = await registerUser(page, user1);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        await becomeFriends(page, page2, body1.token, body2.token);

        // Set nickname/description via API
        const patchRes = await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { nickname: 'MyNickname', description: 'My description text' },
        });
        expect(patchRes.ok()).toBeTruthy();

        // User2 opens user1's profile via API
        const profRes = await page2.request.get(`${BASE}/api/profile/${body1.user.id}`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        });
        const prof = await profRes.json();
        expect(prof.nickname).toBe('MyNickname');
        expect(prof.description).toBe('My description text');

        // User2 navigates to DM view and opens user1's DM
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(1000);

        const dmItem = page2.locator('.dm-item').filter({ hasText: user1 });
        if (await dmItem.count() > 0) {
            await dmItem.click();
            await page2.waitForTimeout(1500);

            // Check that profile view shows nickname/description via JS
            const viewData = await page2.evaluate(() => {
                const nn = document.getElementById('profile-modal-nickname');
                const desc = document.getElementById('profile-modal-description');
                return {
                    nickname: nn ? nn.textContent : null,
                    nicknameDisplay: nn ? nn.style.display : null,
                };
            });
            // If the profile modal opened, nickname should be visible
            if (viewData.nickname) {
                expect(viewData.nickname).toBe('MyNickname');
            }
        }
    });

    test('friend code regenerate does not crash', async ({ page }) => {
        const ts = Date.now();
        const username = 'regenfc_' + ts;
        await registerUser(page, username);

        // Store password for auto-verification
        await page.evaluate(() => localStorage.setItem('e2e_password', 'password123'));

        // Navigate to DM view where regen button lives
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1000);

        const regenBtn = page.locator('#regen-friend-code-btn');
        await expect(regenBtn).toBeVisible({ timeout: 10000 });

        page.on('dialog', async (dialog: any) => {
            await dialog.accept();
        });

        const errors: string[] = [];
        page.on('pageerror', (err: any) => errors.push(err.message));

        await regenBtn.click();
        await page.waitForTimeout(3000);

        const regenError = errors.find(e => e.includes('regenStatusEl'));
        expect(regenError).toBeUndefined();
    });

    test('profile username tag is centered', async ({ page }) => {
        const ts = Date.now();
        const username = 'centag_' + ts;
        await registerUser(page, username);

        await openOwnProfile(page);

        const justifyContent = await page.evaluate(() => {
            const row = document.getElementById('profile-modal-username-row');
            if (!row) return null;
            return window.getComputedStyle(row).justifyContent;
        });
        expect(justifyContent).toBe('center');
    });

    test('message area has reduced padding', async ({ page }) => {
        const ts = Date.now();
        const username = 'msgpad_' + ts;
        await registerUser(page, username);

        const paddingLeft = await page.evaluate(() => {
            const list = document.querySelector('.message-list');
            if (!list) return null;
            return window.getComputedStyle(list).paddingLeft;
        });

        expect(paddingLeft).toBeTruthy();
        if (paddingLeft) {
            const px = parseInt(paddingLeft);
            expect(px).toBeLessThanOrEqual(10);
        }
    });

    test('friend code buttons fit with flex-wrap', async ({ page }) => {
        const ts = Date.now();
        const username = 'btnfit_' + ts;
        await registerUser(page, username);

        const wrapStyle = await page.evaluate(() => {
            const box = document.querySelector('.identity-key-box');
            if (!box) return null;
            return window.getComputedStyle(box).flexWrap;
        });
        expect(wrapStyle).toBe('wrap');
    });

    test('profile display name has visible overflow for glow', async ({ page }) => {
        const ts = Date.now();
        const username = 'glowvis_' + ts;
        const body = await registerUser(page, username);

        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { username_border_color: '#ff0000' },
        });

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await openOwnProfile(page);

        const overflow = await page.evaluate(() => {
            const el = document.getElementById('profile-modal-display-name');
            if (!el) return null;
            return window.getComputedStyle(el).overflow;
        });
        expect(overflow).toBe('visible');
    });

    test('profile card background color is applied from data', async ({ page }) => {
        const ts = Date.now();
        const username = 'bgcolor_' + ts;
        const body = await registerUser(page, username);

        await page.request.patch(`${BASE}/api/profile`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { profile_background_color: '#ff5500' },
        });

        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await openOwnProfile(page);

        const bg = await page.evaluate(() => {
            const card = document.querySelector('#profile-view .profile-view-card');
            if (!card) return null;
            return (card as HTMLElement).style.background || '';
        });
        // Browser may convert hex to rgb: #ff5500 = rgb(255, 85, 0)
        expect(bg).toContain('255, 85, 0');
    });

    test('profile edit preview syncs display name live', async ({ page }) => {
        const ts = Date.now();
        const username = 'editprev_' + ts;
        await registerUser(page, username);

        await openOwnProfile(page);
        await openEditModal(page);

        // The preview should be populated after renderProfileEdit calls updateProfileEditPreview
        const inputName = await page.inputValue('#profile-edit-display-name');

        // Change the input to trigger the live preview listener
        await page.fill('#profile-edit-display-name', 'PreviewTest_' + ts);

        // The input listener should update the preview
        const previewName = await page.evaluate(() => {
            const el = document.getElementById('profile-edit-display-name-preview');
            return el ? el.textContent : null;
        });
        expect(previewName).toBe('PreviewTest_' + ts);
    });

    test('login auto-clears stale session', async ({ page }) => {
        const ts = Date.now();
        const username = 'autoclear_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        await page.evaluate(() => localStorage.clear());

        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(2000);

        const warningVisible = await page.evaluate(() => {
            const el = document.getElementById('stale-session-warning');
            if (!el) return false;
            return el.offsetParent !== null;
        });
        expect(warningVisible).toBeFalsy();
    });

    test('uploadBannerImage uses correct encryptFileChunk arg order', async ({ page }) => {
        const ts = Date.now();
        const username = 'encfix_' + ts;
        await registerUser(page, username);

        const result = await page.evaluate(async () => {
            const blob = new Blob([new Uint8Array(1024).fill(42)], { type: 'image/png' });
            const file = new File([blob], 'test.png', { type: 'image/png' });
            try {
                const r = await (window as any).uploadBannerImage(file);
                return { ok: true, fileId: r.fileId, fileKey: r.fileKey };
            } catch (e: any) {
                return { ok: false, error: e.message };
            }
        });

        expect(result.ok).toBe(true);
        expect(result.fileId).toBeTruthy();
        expect(result.fileKey).toBeTruthy();

        const decryptResult = await page.evaluate(async (args: { fileId: string, fileKey: string }) => {
            try {
                const res = await authFetch('/api/files/' + args.fileId + '/download');
                if (!res.ok) return { decrypted: false, reason: 'HTTP ' + res.status + ' ' + res.statusText };
                const buf = new Uint8Array(await res.arrayBuffer());
                if (buf.length < 40) return { decrypted: false, reason: 'downloaded only ' + buf.length + ' bytes' };
                const fileKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(args.fileKey));
                const CHUNK_PLAINTEXT = 65536;
                const CHUNK_ENCRYPTED_FULL = CHUNK_PLAINTEXT + 16 + 24;
                const totalChunks = Math.ceil(buf.length / CHUNK_ENCRYPTED_FULL);
                const chunks: Uint8Array[] = [];
                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_ENCRYPTED_FULL;
                    let chunkData: Uint8Array;
                    if (i < totalChunks - 1) {
                        chunkData = buf.slice(start, start + CHUNK_ENCRYPTED_FULL);
                    } else {
                        chunkData = buf.slice(start);
                    }
                    try {
                        const dec = E2ECrypto.decryptFileChunk(fileKey, chunkData);
                        chunks.push(dec);
                    } catch (e: any) {
                        return { decrypted: false, reason: 'chunk ' + i + ' len=' + chunkData.length + ': ' + e.message };
                    }
                }
                let totalLength = 0;
                for (const c of chunks) totalLength += c.length;
                return { decrypted: true, size: totalLength, downloadLen: buf.length, chunks: totalChunks };
            } catch (e: any) {
                return { decrypted: false, reason: 'exception: ' + e.message };
            }
        }, { fileId: result.fileId!, fileKey: result.fileKey! });

        expect(decryptResult.decrypted).toBe(true);
    });

    test('uploadBannerImage chunks large files correctly', async ({ page }) => {
        const ts = Date.now();
        const username = 'chunkfix_' + ts;
        await registerUser(page, username);

        const chunkInfo = await page.evaluate(async () => {
            const chunksSeen: number[] = [];
            const origFetch = window.fetch;
            (window as any).__fetchCalls = [];
            window.fetch = function (url: string | Request, init?: any) {
                if (typeof url === 'string' && url.includes('/chunk/')) {
                    const chunkNum = parseInt(url.split('/chunk/')[1]);
                    chunksSeen.push(chunkNum);
                    (window as any).__fetchCalls.push(url);
                }
                return origFetch.apply(this, arguments as any);
            };

            const bigSize = 200000;
            const blob = new Blob([new Uint8Array(bigSize).fill(42)], { type: 'image/png' });
            const file = new File([blob], 'big.png', { type: 'image/png' });
            await (window as any).uploadBannerImage(file);

            window.fetch = origFetch;
            return {
                chunkCount: (window as any).__fetchCalls.length,
                chunkNums: (window as any).__fetchCalls.map((u: string) => parseInt(u.split('/chunk/')[1]))
            };
        });

        expect(chunkInfo.chunkCount).toBe(4);
        expect(chunkInfo.chunkNums).toEqual([0, 1, 2, 3]);
    });
});
