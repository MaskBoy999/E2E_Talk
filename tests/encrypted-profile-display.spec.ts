import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

// Save profile via API (encrypted — only sends encrypted_profile_data)
async function apiSaveProfile(token: string, page: any, displayName: string) {
    // Step 1: Build and encrypt profile data
    const profileData = {
        display_name: displayName,
        nickname: '',
        description: '',
        username_color: '#ff6600',
        username_border_color: '#ff6600',
        profile_background_color: '#1a1a2e',
    };

    // Step 2: Upload per-conversation data via API
    // We use the conversation_profile endpoint
    // For own profile, we also need to update encrypted_profile_data
}

// ============================================================
// ENCRYPTED PROFILE DATA — Server Join
// ============================================================
test.describe('Encrypted Profile Data — Server Join', () => {
    test('both users see encrypted profile data via get_profile API', async ({ browser }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const userA = 'epsrv_a_' + ts;
        const userB = 'epsrv_b_' + ts;
        const displayNameA = 'AliceServer';
        const displayNameB = 'BobServer';

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            // Register both users
            const aInfo = await registerUser(pageA, userA);
            const bInfo = await registerUser(pageB, userB);

            // Create a server via API
            const inviteCode = generateCode(8);
            const srvRes = await pageA.request.post(`${BASE}/api/servers`, {
                headers: { Authorization: 'Bearer ' + aInfo.token, 'Content-Type': 'application/json' },
                data: {
                    name: 'EncryptedSrv_' + ts,
                    invite_code: inviteCode,
                },
            });
            expect(srvRes.ok()).toBeTruthy();
            const srvData = await srvRes.json();

            // User B joins the server
            const joinRes = await pageB.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: 'Bearer ' + bInfo.token, 'Content-Type': 'application/json' },
                data: { code: inviteCode },
            });
            expect(joinRes.ok()).toBeTruthy();

            // Verify both users can access each other's profile via API
            const profARes = await pageB.request.get(`${BASE}/api/profile/` + aInfo.user.id, {
                headers: { Authorization: 'Bearer ' + bInfo.token },
            });
            expect(profARes.ok()).toBeTruthy();
            const profA = await profARes.json();

            // The profile should have encrypted_profile_data (even though display_name is null from API)
            expect(profA.encrypted_profile_data).toBeDefined();
            expect(profA.username).toBe(userA);

            const profBRes = await pageA.request.get(`${BASE}/api/profile/` + bInfo.user.id, {
                headers: { Authorization: 'Bearer ' + aInfo.token },
            });
            expect(profBRes.ok()).toBeTruthy();
            const profB = await profBRes.json();
            expect(profB.encrypted_profile_data).toBeDefined();
            expect(profB.username).toBe(userB);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});

// ============================================================
// ENCRYPTED PROFILE DATA — Friend Connection (DM)
// ============================================================
test.describe('Encrypted Profile Data — Friend Connection', () => {
    test('both users see encrypted profile data after friend connection', async ({ browser }) => {
        test.setTimeout(60000);
        const ts = Date.now();
        const userA = 'epfr_a_' + ts;
        const userB = 'epfr_b_' + ts;

        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        try {
            // Register both users
            const aInfo = await registerUser(pageA, userA);
            const bInfo = await registerUser(pageB, userB);

            // User B sends friend request via API using User A's friend code
            expect(aInfo.friendCode).toBeTruthy();
            const frRes = await pageB.request.post(`${BASE}/api/friends/request`, {
                headers: { Authorization: 'Bearer ' + bInfo.token, 'Content-Type': 'application/json' },
                data: { friend_code: aInfo.friendCode },
            });
            expect(frRes.ok()).toBeTruthy();

            // User A accepts the friend request. The server returns
            // from_user_id HMAC-hashed (privacy), so compute B's hash from the
            // client's e2e_hmac_key to match the request from B.
            const bHmac = await pageB.evaluate((uid) => {
                const hk = localStorage.getItem('e2e_hmac_key');
                if (!hk || !window.E2ECrypto) return null;
                return E2ECrypto.hmacHex(hk, uid);
            }, bInfo.user.id);
            const incomingRes = await pageA.request.get(`${BASE}/api/friends/requests/incoming`, {
                headers: { Authorization: 'Bearer ' + aInfo.token },
            });
            expect(incomingRes.ok()).toBeTruthy();
            const requests = await incomingRes.json();
            let accepted = false;
            for (const req of requests) {
                if (req.from_user_id === bHmac) {
                    const acceptRes = await pageA.request.post(`${BASE}/api/friends/requests/accept`, {
                        headers: { Authorization: 'Bearer ' + aInfo.token, 'Content-Type': 'application/json' },
                        data: { request_id: req.id },
                    });
                    expect(acceptRes.ok()).toBeTruthy();
                    accepted = true;
                }
            }
            expect(accepted).toBeTruthy();

            // Wait for DM to be created
            await pageA.waitForTimeout(2000);

            // Verify both users can access each other's profile via API
            const profARes = await pageB.request.get(`${BASE}/api/profile/` + aInfo.user.id, {
                headers: { Authorization: 'Bearer ' + bInfo.token },
            });
            expect(profARes.ok()).toBeTruthy();
            const profA = await profARes.json();
            expect(profA.encrypted_profile_data).toBeDefined();
            expect(profA.username).toBe(userA);

            const profBRes = await pageA.request.get(`${BASE}/api/profile/` + bInfo.user.id, {
                headers: { Authorization: 'Bearer ' + aInfo.token },
            });
            expect(profBRes.ok()).toBeTruthy();
            const profB = await profBRes.json();
            expect(profB.encrypted_profile_data).toBeDefined();
            expect(profB.username).toBe(userB);
        } finally {
            await ctxA.close();
            await ctxB.close();
        }
    });
});
