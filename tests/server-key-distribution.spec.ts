import { test, expect, type Browser, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function newCtx(browser: Browser) {
    return await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

async function login(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-username', username);
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/** Create a server through the UI and return its id + invite code. */
async function createServer(page: Page, name: string): Promise<{ serverId: string; invite: string }> {
    await page.waitForSelector('#add-server-btn', { timeout: 20000 });
    await page.click('#add-server-btn');
    await page.waitForSelector('#choice-create-server', { state: 'visible', timeout: 10000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 10000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 25000 });
    await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
    await page.waitForTimeout(2000);
    const serverId = await page.evaluate(() =>
        document.querySelector('.server-icon[data-id]:not(.add-server)')?.getAttribute('data-id') || '');
    const invite = await page.evaluate((sid) => localStorage.getItem('e2e_invite_' + sid) || '', serverId);
    expect(serverId).toBeTruthy();
    expect(invite).toBeTruthy();
    return { serverId, invite };
}

/** Join through the real UI path (`joinServer()`), which runs the key fetch-retry loop. */
async function joinViaUi(page: Page, invite: string) {
    await page.evaluate(async (code: string) => {
        const input = document.getElementById('invite-code-input') as HTMLInputElement;
        input.value = code;
        await (window as any).joinServer();
    }, invite);
}

/**
 * Can this page actually USE the given server key, i.e. decrypt the server's own
 * encrypted name with it? This is exactly the user-visible "can't decrypt" state.
 */
async function serverKeyState(page: Page, serverId: string) {
    return await page.evaluate(async (sid: string) => {
        const W = window as any;
        const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
        const key = W.E2ECrypto.getServerKey(sid);
        const identity = W.E2ECrypto.getIdentityKeyPair(uid);

        let serverName: string | null = null;
        try {
            const res = await fetch('/api/servers', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const servers = await res.json();
            const s = (servers || []).find((x: any) => x.id === sid);
            if (s && s.encrypted_name && s.name_nonce && key) {
                serverName = W.E2ECrypto.decryptMessage(s.encrypted_name, s.name_nonce, key) || null;
            }
        } catch (_) { /* leave null */ }

        return { hasServerKey: !!key, identityPresent: !!identity, serverName };
    }, serverId);
}

async function waitForServerKey(page: Page, serverId: string, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let state = await serverKeyState(page, serverId);
    while (!state.hasServerKey && Date.now() < deadline) {
        await page.waitForTimeout(500);
        state = await serverKeyState(page, serverId);
    }
    return state;
}

test.describe('Server key distribution', () => {

    test('owner can decrypt the server key, including after a reload', async ({ browser }) => {
        test.setTimeout(180000);
        const ctx = await newCtx(browser);
        const page = await ctx.newPage();
        await register(page, unique('sk_owner'));
        const { serverId } = await createServer(page, 'Owner Key Server');

        const fresh = await serverKeyState(page, serverId);
        expect(fresh.identityPresent, 'owner has an identity key').toBe(true);
        expect(fresh.hasServerKey, 'owner can decrypt the server key right after creating it').toBe(true);
        expect(fresh.serverName, 'owner can decrypt the server name with it').toBe('Owner Key Server');

        // Regression: a plain reload must not orphan the key (the storage-key
        // migration must not lose values encrypted under the previous key).
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(2500);
        const afterReload = await waitForServerKey(page, serverId);
        expect(afterReload.identityPresent, 'identity key survives a reload').toBe(true);
        expect(afterReload.hasServerKey, 'server key survives a reload').toBe(true);
        expect(afterReload.serverName, 'server name still decrypts after reload').toBe('Owner Key Server');

        await ctx.close();
    });

    test('a joiner receives a decryptable server key, after reload and on a fresh-device login', async ({ browser }) => {
        test.setTimeout(240000);
        const ownerCtx = await newCtx(browser);
        const ownerPage = await ownerCtx.newPage();
        await register(ownerPage, unique('sk_owner2'));
        const { serverId, invite } = await createServer(ownerPage, 'Shared Key Server');

        const joinerName = unique('sk_joiner');
        const joinerCtx = await newCtx(browser);
        const joinerPage = await joinerCtx.newPage();
        await register(joinerPage, joinerName);
        await joinViaUi(joinerPage, invite);

        const joined = await waitForServerKey(joinerPage, serverId);
        expect(joined.identityPresent, 'joiner has an identity key').toBe(true);
        expect(joined.hasServerKey, 'joiner receives a decryptable server key').toBe(true);
        expect(joined.serverName, 'joiner can decrypt the server name').toBe('Shared Key Server');

        await joinerPage.reload({ waitUntil: 'load' });
        await joinerPage.waitForTimeout(2500);
        const afterReload = await waitForServerKey(joinerPage, serverId);
        expect(afterReload.hasServerKey, 'joiner still has the key after a reload').toBe(true);

        // Make sure the joiner's key blob (which now carries the server key) is saved.
        await joinerPage.evaluate(() => { try { (window as any).saveKeyBlobToServer(); } catch (_) {} });
        await joinerPage.waitForTimeout(1500);

        // Regression for the fresh-device login path: an account that LOGS IN
        // (rather than registers) must keep its restored identity + server key
        // instead of orphaning them during the storage-key rekey.
        const freshCtx = await newCtx(browser);
        const freshPage = await freshCtx.newPage();
        await login(freshPage, joinerName);
        const freshDevice = await waitForServerKey(freshPage, serverId);
        expect(freshDevice.identityPresent, 'fresh-device login restores the identity key').toBe(true);
        expect(freshDevice.hasServerKey, 'fresh-device login restores the server key').toBe(true);
        expect(freshDevice.serverName, 'fresh-device login can decrypt the server name').toBe('Shared Key Server');

        await ownerCtx.close();
        await joinerCtx.close();
        await freshCtx.close();
    });

    test('the in-app recovery action restores orphaned identity + server keys without a logout', async ({ browser }) => {
        test.setTimeout(180000);
        const ctx = await newCtx(browser);
        const page = await ctx.newPage();
        await register(page, unique('sk_recover'));
        const { serverId } = await createServer(page, 'Recovery Server');
        expect((await serverKeyState(page, serverId)).serverName).toBe('Recovery Server');

        // Simulate the orphaned state: the local identity + server keys are gone
        // (this is what a broken storage-key rekey left behind) while the user
        // stays logged in.
        await page.evaluate((sid: string) => {
            const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
            localStorage.removeItem('e2e_identity_private_' + uid);
            localStorage.removeItem('e2e_server_' + sid);
            localStorage.removeItem('e2e_server_history_' + sid);
        }, serverId);

        const orphaned = await serverKeyState(page, serverId);
        expect(orphaned.identityPresent, 'identity key is gone (orphaned state)').toBe(false);
        expect(orphaned.hasServerKey, 'server key is gone (orphaned state)').toBe(false);

        // The recovery action must restore them from the server key blob in place.
        const result = await page.evaluate(async (pw: string) => {
            return await (window as any).recoverEncryptionKeys(pw);
        }, PASSWORD);
        expect(result.ok, 'recovery action reports success: ' + (result.error || '')).toBe(true);

        const recovered = await waitForServerKey(page, serverId);
        expect(recovered.identityPresent, 'identity key restored from the blob').toBe(true);
        expect(recovered.hasServerKey, 'server key restored without a logout').toBe(true);
        expect(recovered.serverName, 'server name decrypts again after recovery').toBe('Recovery Server');

        await ctx.close();
    });
});
