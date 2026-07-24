import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any) {
    const username = 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    await page.goto(BASE + '/login.html');
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(2000);
}

test.describe('Bug fixes: DM auto-select & server key decryption', () => {

  test('DM auto-select after accepting friend request via UI', async ({ browser }) => {
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await registerUser(pageA);
    await registerUser(pageB);

    // Send friend request from User A to User B via API
    const tokenA = await pageA.evaluate(() => localStorage.getItem('token'));
    const friendCodeB = await pageB.evaluate(() => localStorage.getItem('e2e_friend_code'));

    const frRes = await pageA.request.post(BASE + '/api/friends/request', {
        headers: { Authorization: 'Bearer ' + tokenA, 'Content-Type': 'application/json' },
        data: { friend_code: friendCodeB },
    });
    expect(frRes.ok()).toBeTruthy();

    // Wait for WS notification to arrive at User B
    await pageB.waitForTimeout(3000);

    // User B clicks friend-requests-btn in DM sidebar
    const requestsBtn = pageB.locator('#friend-requests-btn');
    await expect(requestsBtn).toBeVisible({ timeout: 5000 });
    await requestsBtn.click();
    await pageB.waitForSelector('#friend-requests-modal', { state: 'visible', timeout: 5000 });
    await pageB.waitForTimeout(1000);

    // User B clicks Accept on the first friend request
    const acceptBtn = pageB.locator('#friend-requests-list .btn-accept').first();
    await expect(acceptBtn).toBeVisible({ timeout: 5000 });
    await acceptBtn.click();
    await pageB.waitForTimeout(3000);

    // VERIFY: DM conversation is auto-selected
    const channelText = await pageB.evaluate(() => {
        const el = document.getElementById('channel-name');
        return el ? el.textContent : '';
    });
    console.log('Channel name:', channelText);
    expect(channelText).not.toBe('Select a conversation');

    // VERIFY: message input is enabled
    const inputDisabled = await pageB.evaluate(() => {
        const input = document.getElementById('message-input') as HTMLInputElement;
        return input ? input.disabled : true;
    });
    expect(inputDisabled).toBe(false);

    // VERIFY: friend code regen button is still wired
    const regenWired = await pageB.evaluate(() => {
        const btn = document.getElementById('regen-friend-code-btn');
        return btn && typeof (btn as any).onclick === 'function';
    });
    expect(regenWired).toBe(true);

    await ctxA.close();
    await ctxB.close();
  });

  test('server key available after joining a server', async ({ browser }) => {
    test.setTimeout(60000);
    
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await registerUser(pageA);
    await registerUser(pageB);

    // User A creates server via UI
    await pageA.click('#add-server-btn');
    await pageA.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await pageA.click('#choice-create-server');
    await pageA.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await pageA.waitForTimeout(500);

    const serverName = 'KeyTest_' + Date.now();
    await pageA.fill('#new-server-name', serverName);
    await pageA.click('#confirm-create-server');
    await pageA.waitForTimeout(4000);

    // Get invite code from localStorage
    const inviteCode = await pageA.evaluate(() => {
        const icons = document.querySelectorAll('.server-icon:not(.add-server):not(.dm-strip-btn)');
        const last = icons[icons.length - 1];
        return last ? localStorage.getItem('e2e_invite_' + last.getAttribute('data-id')) : null;
    });
    expect(inviteCode).toBeTruthy();

    // User B joins server via UI
    await pageB.click('#add-server-btn');
    await pageB.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
    await pageB.click('#choice-join-server');
    await pageB.waitForSelector('#join-server-modal', { state: 'visible', timeout: 5000 });
    await pageB.waitForTimeout(500);
    await pageB.fill('#invite-code-input', inviteCode!);
    await pageB.click('#confirm-join-server');
    await pageB.waitForTimeout(10000);

    // User B clicks the server
    await pageB.evaluate(() => {
        const icons = document.querySelectorAll('.server-icon:not(.add-server):not(.dm-strip-btn)');
        if (icons.length > 0) (icons[icons.length - 1] as HTMLElement).click();
    });
    await pageB.waitForTimeout(8000);

    // VERIFY: No "Cannot decrypt server key"
    const channelText = await pageB.evaluate(() => {
        return document.getElementById('channel-list')?.textContent || '';
    });
    // VERIFY: Channel names are decrypted (not showing [encrypted])
    console.log('Channels:', channelText);
    expect(channelText).not.toContain('Cannot decrypt server key');
    expect(channelText).not.toContain('[encrypted]');

    // VERIFY: Server name is visible and not "[encrypted]"
    const srvName = await pageB.evaluate(() => {
        return document.getElementById('server-name')?.textContent || '';
    });
    console.log('Server name:', srvName);
    expect(srvName).not.toBe('Direct Messages');
    expect(srvName).not.toBe('[encrypted]');
    expect(srvName).not.toBe('');

    await ctxA.close();
    await ctxB.close();
  });

});
