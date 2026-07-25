import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

test.describe('DM Identity Preservation After Reload', () => {

    test('messages from two users show distinct sender IDs, display names preserved after page reload', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1Name = 'dmident1_' + ts;
        const user2Name = 'dmident2_' + ts;

        // Register both users
        const body1 = await registerUser(page, user1Name);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2Name);

        // Become friends (creates DM channel)
        await becomeFriends(page, page2, body1.token, body2.token);

        // Reload both pages fresh to ensure clean state for messaging
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);

        // User1 opens DM and sends a message
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(2000);
        await page.waitForSelector('.dm-item', { timeout: 10000 });
        await page.locator('.dm-item').first().click();
        await page.waitForTimeout(2000);
        const input1 = page.locator('#message-input');
        await expect(input1).toBeEnabled({ timeout: 10000 });
        await input1.fill('Hello from UserOne');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 opens DM and sends a message
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);
        await page2.waitForSelector('.dm-item', { timeout: 10000 });
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(2000);
        const input2 = page2.locator('#message-input');
        await expect(input2).toBeEnabled({ timeout: 10000 });
        await input2.fill('Hello from UserTwo');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // User1 sends another message
        await page.bringToFront();
        await page.waitForTimeout(500);
        await input1.fill('Another from UserOne');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // User2 sends another message
        await page2.bringToFront();
        await page2.waitForTimeout(500);
        await input2.fill('Another from UserTwo');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // ================================================================
        // PART 1: Verify identity BEFORE reload (baseline)
        // ================================================================
        await page2.bringToFront();
        await page2.waitForTimeout(1000);
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(3000);

        const msgsBefore = await page2.evaluate(() => {
            const msgEls = document.querySelectorAll('.message');
            return Array.from(msgEls).map(el => {
                const dnEl = el.querySelector('.display-name');
                return {
                    displayName: dnEl ? dnEl.textContent : null,
                    senderId: el.getAttribute('data-sender-id'),
                };
            });
        });
        console.log('Messages before reload:', JSON.stringify(msgsBefore, null, 2));
        expect(msgsBefore.length).toBeGreaterThanOrEqual(4);

        // Verify at least 2 distinct display names (each user's raw username from encrypted_sender_username)
        const namesBefore = [...new Set(msgsBefore.map(m => m.displayName).filter(Boolean))];
        console.log('Unique display names before reload:', namesBefore);
        expect(namesBefore.length).toBeGreaterThanOrEqual(2);

        // Verify at least 2 distinct sender IDs
        const senderIdsBefore = [...new Set(msgsBefore.map(m => m.senderId).filter(Boolean))];
        console.log('Unique sender IDs before reload:', senderIdsBefore);
        expect(senderIdsBefore.length).toBeGreaterThanOrEqual(2);

        // ================================================================
        // PART 2: Reload page2 and verify identity is preserved
        // ================================================================
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(2000);
        await page2.waitForSelector('.dm-item', { timeout: 10000 });
        await page2.locator('.dm-item').first().click();
        await page2.waitForTimeout(5000);

        const msgsAfter = await page2.evaluate(() => {
            const msgEls = document.querySelectorAll('.message');
            return Array.from(msgEls).map(el => {
                const dnEl = el.querySelector('.display-name');
                return {
                    displayName: dnEl ? dnEl.textContent : null,
                    senderId: el.getAttribute('data-sender-id'),
                };
            });
        });
        console.log('Messages after reload:', JSON.stringify(msgsAfter, null, 2));
        expect(msgsAfter.length).toBeGreaterThanOrEqual(4);

        // Verify distinct display names preserved after reload
        const namesAfter = [...new Set(msgsAfter.map(m => m.displayName).filter(Boolean))];
        console.log('Unique display names after reload:', namesAfter);
        expect(namesAfter.length).toBeGreaterThanOrEqual(2);

        // Verify distinct sender IDs preserved after reload
        const senderIdsAfter = [...new Set(msgsAfter.map(m => m.senderId).filter(Boolean))];
        console.log('Unique sender IDs after reload:', senderIdsAfter);
        expect(senderIdsAfter.length).toBeGreaterThanOrEqual(2);

        // Verify that each user's messages consistently show their display name
        // Map display names to their associated sender IDs for consistency check
        const nameSenderPairs = msgsAfter.map(m => `${m.displayName}:${m.senderId}`);
        const uniquePairs = [...new Set(nameSenderPairs)];
        console.log('Unique displayName:senderId pairs:', uniquePairs);
        expect(uniquePairs.length).toBeGreaterThanOrEqual(2);

        await page2.close();
        await ctx2.close();
    });
});
