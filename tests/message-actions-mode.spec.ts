// The per-message action row (pin, react, edit, delete, ⋯) with its Display
// setting, and the two bugs that hid actions: the ⋯ menu read a `myUserId`
// that did not exist in its scope (so Edit/Delete never appeared), and
// blockUser() let a rejected self-block mark you as blocked anyway.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerAndKey(page: Page, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const keys = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Actions Test Server', key),
            encChName: E2ECrypto.encryptMessage('general', key),
        };
    });
    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: keys.encName.ciphertext,
            name_nonce: keys.encName.nonce,
            channel_encrypted_name: keys.encChName.ciphertext,
            channel_name_nonce: keys.encChName.nonce,
        },
    });
    const server = await res.json();
    await page.evaluate(async ({ serverId, userId, keyB64 }: { serverId: string; userId: string; keyB64: string }) => {
        const serverKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId, keyB64: keys.keyB64 });
    return { serverId: server.id, inviteCode };
}

async function openChannelAndSend(page: Page, text: string) {
    await page.evaluate(async () => { await loadServers(); });
    await page.waitForTimeout(1500);
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(1500);
    await page.fill('#message-input', text);
    await page.click('#send-btn');
    await page.waitForSelector('.message .text', { timeout: 20000 });
}

async function setMode(page: Page, mode: 'hover' | 'always' | 'off') {
    await page.evaluate((m: string) => {
        const sel = document.getElementById('show-msg-actions') as HTMLSelectElement;
        sel.value = m;
        sel.dispatchEvent(new Event('change'));
    }, mode);
}

async function menuLabels(page: Page): Promise<string[]> {
    await page.waitForSelector('.channel-context-menu', { timeout: 10000 });
    return (await page.locator('.channel-context-menu .context-menu-item').allTextContents()).map((s) => s.trim());
}

async function dismissMenu(page: Page) {
    await page.evaluate(() => document.querySelectorAll('.channel-context-menu').forEach((m) => m.remove()));
}

test.describe('message action modes', () => {
    test('off / always / hover control the row, with ⋯ alongside the shortcuts', async ({ page }) => {
        test.setTimeout(180000);
        const body = await registerUser(page, 'act_' + Date.now());
        await createServerAndKey(page, body.token, body.user.id);
        await openChannelAndSend(page, 'a message with actions');

        const more = page.locator('.message .msg-action-btn[data-action="more"]').last();
        const react = page.locator('.message .msg-action-btn[data-action="react"]').last();

        // Default is hover. There is no stored preference until it is changed,
        // and at rest the row is hidden (no hover, mouse is over the send button).
        expect(await page.evaluate(() => localStorage.getItem('show_msg_actions'))).toBeNull();
        await expect(more).toBeHidden();

        // Always on: ⋯ and the shortcuts are all visible together.
        await setMode(page, 'always');
        expect(await page.evaluate(() => localStorage.getItem('show_msg_actions'))).toBe('always');
        await expect(more).toBeVisible();
        await expect(react).toBeVisible();
        await expect(page.locator('.message .msg-action-btn[data-action="edit"]').last()).toBeVisible();

        // Off: the whole row is gone.
        await setMode(page, 'off');
        await expect(more).toBeHidden();
        await expect(react).toBeHidden();

        // Back to hover: hidden at rest, revealed on hover.
        await setMode(page, 'hover');
        await expect(more).toBeHidden();
        await page.locator('.message').last().hover();
        await expect(more).toBeVisible();
    });

    test('the ⋯ menu offers Edit/Delete on your own message and never Block on yourself', async ({ page }) => {
        test.setTimeout(180000);
        const body = await registerUser(page, 'actmenu_' + Date.now());
        await createServerAndKey(page, body.token, body.user.id);
        await openChannelAndSend(page, 'my own message');

        // Anchor the mode so the ⋯ is reachable regardless of hover quirks.
        await setMode(page, 'always');
        await page.locator('.message .msg-action-btn[data-action="more"]').last().click();
        const labels = await menuLabels(page);
        expect(labels).toContain('Edit');
        expect(labels).toContain('Delete');
        expect(labels).not.toContain('Block User');
        await dismissMenu(page);
    });

    test('blockUser refuses your own id and never touches the local block list', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page, 'actblock_' + Date.now());

        const outcome = await page.evaluate(async () => {
            const me = JSON.parse(localStorage.getItem('user') || '{}').id;
            const w = window as unknown as { blockedUsers: string[]; blockUser: (id: string) => Promise<void> };
            const before = (w.blockedUsers || []).length;
            await w.blockUser(me);
            const list = w.blockedUsers || [];
            return { before, after: list.length, hasSelf: list.indexOf(me) !== -1 };
        });
        expect(outcome.hasSelf, 'your own id must never enter the block list').toBe(false);
        expect(outcome.after).toBe(outcome.before);
    });
});
