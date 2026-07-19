import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Friend Requests Disabled Setting', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));
    }

    test('toggle block incoming friend requests via settings UI', async ({ page }) => {
        const ts = Date.now();
        const username = 'frblock_toggle_' + ts;
        await registerUser(page, username);

        // Open settings
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });

        // The toggle label (the checkbox input is visually hidden, so click the label)
        const toggleLabel = page.locator('label').filter({ hasText: 'Block incoming friend requests' });
        await expect(toggleLabel).toBeVisible();

        // Verify it starts unchecked
        const toggle = page.locator('#disable-friend-requests-toggle');
        expect(await toggle.isChecked()).toBe(false);

        // Toggle it on by clicking the label
        await toggleLabel.click();
        await page.waitForTimeout(500);

        // Verify it's now checked
        expect(await toggle.isChecked()).toBe(true);

        // Verify via API that the setting was saved
        const token = await page.evaluate(() => localStorage.getItem('token'));
        const getRes = await (await page.request.get(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${token}` },
        })).json();
        expect(getRes.friend_requests_disabled).toBe(true);

        // Toggle it off by clicking the label again
        await toggleLabel.click();
        await page.waitForTimeout(500);

        // Verify it's unchecked
        expect(await toggle.isChecked()).toBe(false);

        // Verify via API that the setting was saved
        const getRes2 = await (await page.request.get(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${token}` },
        })).json();
        expect(getRes2.friend_requests_disabled).toBe(false);

        await page.click('#close-settings');
    });

    test('cannot send friend request when recipient has blocked incoming requests', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'frblock_sender_' + ts;
        const user2 = 'frblock_recipient_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // User2 enables block via API
        const blockRes = await page2.request.post(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { disabled: true },
        });
        expect(blockRes.ok()).toBeTruthy();

        // User1 tries to send friend request to User2
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const sendRes = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });

        // Should fail with an error
        expect(sendRes.ok()).toBeFalsy();
        const sendErr = await sendRes.json();
        expect(sendErr.error).toContain('not accepting friend requests');

        // User2 should have no pending requests
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBe(0);

        await page2.close();
        await ctx2.close();
    });

    test('can send friend request after recipient unblocks', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'frblock_unblock1_' + ts;
        const user2 = 'frblock_unblock2_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // User2 enables block
        await page2.request.post(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { disabled: true },
        });

        // User1 tries to send — should fail
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const failRes = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(failRes.ok()).toBeFalsy();

        // User2 disables the block
        const unblockRes = await page2.request.post(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { disabled: false },
        });
        expect(unblockRes.ok()).toBeTruthy();

        // User1 tries again — should succeed now
        const successRes = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(successRes.ok()).toBeTruthy();

        // Verify User2 has a pending request now
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBe(1);

        await page2.close();
        await ctx2.close();
    });

    test('block setting persists across page reload', async ({ page }) => {
        const ts = Date.now();
        const username = 'frblock_persist_' + ts;
        await registerUser(page, username);

        // Enable via API directly (more reliable than clicking the UI toggle)
        const token = await page.evaluate(() => localStorage.getItem('token'));
        const setRes = await page.request.post(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { disabled: true },
        });
        expect(setRes.ok()).toBeTruthy();

        // Verify via API that it was saved
        const getRes = await (await page.request.get(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${token}` },
        })).json();
        expect(getRes.friend_requests_disabled).toBe(true);

        // Reload the page
        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });

        // Open settings and verify the toggle reflects the saved setting
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(1000); // wait for loadFriendRequestsDisabledSetting() API call
        const toggleAfterReload = page.locator('#disable-friend-requests-toggle');
        expect(await toggleAfterReload.isChecked()).toBe(true);

        await page.click('#close-settings');
    });

    test('existing friendships are unaffected by block setting', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'frblock_friend1_' + ts;
        const user2 = 'frblock_friend2_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Become friends first
        const friendCode2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: friendCode2 },
        });
        expect(fr.ok()).toBeTruthy();

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();

        // Verify they are friends
        const friends = await (await page.request.get(`${BASE}/api/friends`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(Array.isArray(friends)).toBe(true);
        expect(friends.some((f: any) => f.username === user2)).toBeTruthy();

        // User2 enables block
        await page2.request.post(`${BASE}/api/friends/requests/disabled`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { disabled: true },
        });

        // Verify they are still friends
        const friendsAfter = await (await page.request.get(`${BASE}/api/friends`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(Array.isArray(friendsAfter)).toBe(true);
        expect(friendsAfter.some((f: any) => f.username === user2)).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });
});
