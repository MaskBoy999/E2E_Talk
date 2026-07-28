import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Invite & Friend Code Integration', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(2000);
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));
    }

    test('friend code: register two users and send friend request by code', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'fcsender_' + ts;

        // Register user1
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();
        expect(body1.friendCode).toBeTruthy();
        console.log('User1 friend code:', body1.friendCode);

        // Register user2 in a new context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const user2 = 'fcreceiver_' + ts;
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // User2 sends friend request to user1 using user1's friend code
        const frRes = await page2.request.post(`${BASE}/api/friends/request`, {
            headers: {
                'Authorization': `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { friend_code: body1.friendCode },
        });
        expect(frRes.ok()).toBeTruthy();
        const frData = await frRes.json();
        expect(frData.ok).toBe(true);
        expect(frData.to.username).toBe(user1);

        // User1 checks incoming friend requests
        const incomingRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { 'Authorization': `Bearer ${body1.token}` },
        });
        expect(incomingRes.ok()).toBeTruthy();
        const incoming = await incomingRes.json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBe(1);
        expect(incoming[0].from_username).toBe(user2);

        // User1 accepts the friend request
        const acceptRes = await page.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: {
                'Authorization': `Bearer ${body1.token}`,
                'Content-Type': 'application/json',
            },
            data: { request_id: incoming[0].id },
        });
        expect(acceptRes.ok()).toBeTruthy();

        // Verify friendship exists
        const friendsRes = await page.request.get(`${BASE}/api/friends`, {
            headers: { 'Authorization': `Bearer ${body1.token}` },
        });
        expect(friendsRes.ok()).toBeTruthy();
        const friends = await friendsRes.json();
        const found = friends.some((f: any) => f.username === user2);
        expect(found).toBe(true);

        await page2.close();
        await ctx2.close();
    });

    test('friend code: registering without friend code still works', async ({ page }) => {
        const ts = Date.now();
        const username = 'nofc_' + ts;

        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });

        const token = await page.evaluate(() => localStorage.getItem('token'));
        expect(token).toBeTruthy();

        // Should still get a friend code from the server
        const fcRes = await page.request.get(`${BASE}/api/friend-code`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(fcRes.ok()).toBeTruthy();
    });

    test('invite code: create server and join with invite code', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'owner_' + ts;
        const user2 = 'joiner_' + ts;

        // Register server owner
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Register joiner in a new context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Generate invite code and create server
        const inviteCode = 'INVITE' + ts.toString(36).toUpperCase();

        // Use the API to create server
        const createRes = await page.request.post(`${BASE}/api/servers`, {
            headers: {
                'Authorization': `Bearer ${body1.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: 'TestServer',
                invite_code: inviteCode,
            },
        });
        expect(createRes.ok()).toBeTruthy();
        const serverData = await createRes.json();
        expect(serverData.id).toBeTruthy();
        console.log('Created server:', serverData.id, 'with code:', inviteCode);

        // Join the server with the invite code as user2
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: {
                'Authorization': `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { code: inviteCode },
        });

        // If this fails, log the error for debugging
        if (!joinRes.ok()) {
            const joinErr = await joinRes.json();
            console.log('Join failed with:', JSON.stringify(joinErr));
        }
        expect(joinRes.ok()).toBeTruthy();
        const joinData = await joinRes.json();
        expect(joinData.id).toBe(serverData.id);

        // Verify user2 sees the server in their list
        const user2Servers = await (await page2.request.get(`${BASE}/api/servers`, {
            headers: { 'Authorization': `Bearer ${body2.token}` },
        })).json();
        const found = user2Servers.some((s: any) => s.id === serverData.id);
        expect(found).toBe(true);

        await page2.close();
        await ctx2.close();
    });

    test('invite code: wrong code is rejected', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'owner2_' + ts;
        const user2 = 'joiner2_' + ts;

        const body1 = await registerUser(page, user1);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);

        // Create server
        const createRes = await page.request.post(`${BASE}/api/servers`, {
            headers: {
                'Authorization': `Bearer ${body1.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: 'SecureServer',
                invite_code: 'REALCODE999',
            },
        });
        expect(createRes.ok()).toBeTruthy();

        // Try joining with wrong code
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: {
                'Authorization': `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { code: 'WRONGCODE123' },
        });
        expect(joinRes.ok()).toBeFalsy();

        // Now join with correct code — should succeed
        const joinOk = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: {
                'Authorization': `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { code: 'REALCODE999' },
        });
        expect(joinOk.ok()).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('invite code: wrong friend code is rejected', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'fcreject_' + ts;
        const body1 = await registerUser(page, user1);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, 'fcreject2_' + ts);

        // Try sending friend request with a non-existent friend code
        const frRes = await page2.request.post(`${BASE}/api/friends/request`, {
            headers: {
                'Authorization': `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { friend_code: 'NONEXISTENT12345' },
        });

        // Should be rejected
        expect(frRes.ok()).toBeFalsy();
        const frErr = await frRes.json();
        expect(frErr.error).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('full e2e: friend + server roundtrip', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'alice_' + ts;
        const user2 = 'bob_' + ts;

        // Register both users
        const body1 = await registerUser(page, user1);
        expect(body1.friendCode).toBeTruthy();

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.friendCode).toBeTruthy();

        // 1) Friend connection: send and accept
        const frRes = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: body2.friendCode },
        });
        expect(frRes.ok()).toBeTruthy();

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(incoming.length).toBe(1);

        const acceptRes = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acceptRes.ok()).toBeTruthy();

        // 2) Server: Alice creates, Bob joins
        const inviteCode = 'E2ETEST' + ts;
        const createRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { name: 'E2EServer', invite_code: inviteCode },
        });
        expect(createRes.ok()).toBeTruthy();
        const serverData = await createRes.json();

        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();
        const joinData = await joinRes.json();
        expect(joinData.id).toBe(serverData.id);

        // 3) Verify Bob is a member
        const serverMembers = await (await page.request.get(`${BASE}/api/servers/${serverData.id}/members`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const bobInServer = serverMembers.some((m: any) => m.username === user2);
        expect(bobInServer).toBe(true);

        await page2.close();
        await ctx2.close();
    });
});
