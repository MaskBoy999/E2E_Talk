import { test, expect, Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Profile pictures get their own auto-load setting, separate from
// autoLoadPreviews: with it off, an avatar that is not cached stays as the
// user's initial and arms itself as click-to-load, and *nothing* is fetched
// from /api/files for it until the user clicks.

test.describe('Profile picture auto-load setting', () => {
    test.setTimeout(90000);

    async function register(page: Page, name: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', name);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForFunction(() => typeof (window as any).getProfilePicUrl === 'function');
    }

    // A 64-hex-char file id takes the by-hash download URL, so the spec can
    // assert on the exact request without a real upload.
    const FAKE_FID = 'a'.repeat(64);

    async function injectPlaceholder(page: Page, userId: string, fileId: string) {
        return page.evaluate(([uid, fid]) => {
            document.querySelectorAll('[data-pfp-test]').forEach((el) => el.remove());
            const el = document.createElement('div');
            el.id = 'pfp-test-avatar';
            el.setAttribute('data-pfp-test', '1');
            el.setAttribute('data-profile-pic-load', uid + ':' + fid);
            el.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:99999;'
                + 'border-radius:50%;background:#333;color:#fff;text-align:center;line-height:32px;';
            el.textContent = 'T';
            document.body.appendChild(el);
            return true;
        }, [userId, fileId] as const);
    }

    test('the toggle sits beside the media previews one, defaults on, and saves', async ({ page }) => {
        const ts = Date.now();
        await register(page, 'pfptog_' + ts);

        const sameGroup = await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement | null;
            const previews = document.getElementById('auto-load-previews');
            if (!cb || !previews) return null;
            return {
                checked: cb.checked,
                stored: localStorage.getItem('autoLoadProfilePics'),
                // The separate toggle must be offered next to the previews one.
                sameParent: cb.closest('.settings-group') === previews.closest('.settings-group'),
                label: (cb.parentElement!.textContent || '').trim(),
            };
        });
        expect(sameGroup).not.toBeNull();
        expect(sameGroup!.checked).toBe(true);
        expect(sameGroup!.stored).toBeNull();
        expect(sameGroup!.sameParent).toBe(true);
        expect(sameGroup!.label).toContain('profile pictures');

        // Flipping it off persists, and so does turning it back on.
        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => localStorage.getItem('autoLoadProfilePics'))).toBe('false');
        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        });
        expect(await page.evaluate(() => localStorage.getItem('autoLoadProfilePics'))).toBe('true');
    });

    test('with it off, an avatar fetches nothing until clicked, then loads that one', async ({ page }) => {
        const ts = Date.now();
        await register(page, 'pfpnet_' + ts);
        const userId = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
        expect(userId).toBeTruthy();

        const downloads: string[] = [];
        await page.route('**/api/files/**', async (route) => {
            downloads.push(route.request().url());
            await route.fulfill({ status: 404, body: 'nope' });
        });

        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });

        await injectPlaceholder(page, userId, FAKE_FID);
        // Armed as click-to-load, with the loading marker taken off.
        await page.waitForSelector('#pfp-test-avatar[data-profile-pic-manual]', { timeout: 5000 });
        const state = await page.evaluate(() => {
            const el = document.getElementById('pfp-test-avatar')!;
            return {
                manual: el.getAttribute('data-profile-pic-manual'),
                loading: el.getAttribute('data-profile-pic-load'),
            };
        });
        expect(state.manual).toBe(userId + ':' + FAKE_FID);
        expect(state.loading).toBeNull();

        // Rendering alone fetched nothing.
        expect(downloads.filter((u) => u.includes(FAKE_FID))).toHaveLength(0);

        // Clicking it loads just that picture.
        await page.click('#pfp-test-avatar');
        await expect.poll(() => downloads.filter((u) => u.includes(FAKE_FID)).length, { timeout: 5000 }).toBe(1);
        expect(downloads.filter((u) => u.includes(FAKE_FID))[0]).toContain('/api/files/by-hash/' + FAKE_FID + '/download');
    });

    test('turning it back on loads every avatar that was waiting', async ({ page }) => {
        const ts = Date.now();
        await register(page, 'pfpon_' + ts);
        const userId = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);

        const downloads: string[] = [];
        await page.route('**/api/files/**', async (route) => {
            downloads.push(route.request().url());
            await route.fulfill({ status: 404, body: 'nope' });
        });

        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
        await injectPlaceholder(page, userId, FAKE_FID);
        await page.waitForSelector('#pfp-test-avatar[data-profile-pic-manual]', { timeout: 5000 });
        expect(downloads.filter((u) => u.includes(FAKE_FID))).toHaveLength(0);

        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        });
        await expect.poll(() => downloads.filter((u) => u.includes(FAKE_FID)).length, { timeout: 5000 }).toBe(1);
        expect(await page.evaluate(() => document.querySelectorAll('[data-profile-pic-manual]').length)).toBe(0);
    });

    test('the setting survives a reload and still arms late-rendered avatars', async ({ page }) => {
        const ts = Date.now();
        await register(page, 'pfprel_' + ts);
        const userId = await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);

        await page.evaluate(() => {
            const cb = document.getElementById('auto-load-profile-pics') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).getProfilePicUrl === 'function');
        expect(await page.evaluate(() => (document.getElementById('auto-load-profile-pics') as HTMLInputElement).checked)).toBe(false);

        // A placeholder inserted *after* render is still armed by the observer —
        // the ordering case a one-shot pass at call time would miss.
        await injectPlaceholder(page, userId, FAKE_FID);
        await page.waitForSelector('#pfp-test-avatar[data-profile-pic-manual]', { timeout: 5000 });
    });
});
