import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// 1x1 transparent PNG (valid magic bytes so G5's checkUploadMagic accepts it).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

/** Register through the UI (identity keys + token land in localStorage), then
 *  create a server with a properly uploaded server key so the sidebar renders it. */
async function registerAndSetupServer(page: any): Promise<{ token: string; user: any; serverId: string; channelId: string; inviteCode: string }> {
    const ts = Date.now();
    const username = 'paste_u_' + ts;

    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

    const body = await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));

    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${body.token}` },
        data: { name: 'Paste Test Server ' + ts, invite_code: inviteCode },
    });
    const server = await srv.json();

    // Generate + upload the server key so the server name/channel decrypt.
    await page.evaluate(async ({ serverId, userId }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId: body.user.id });

    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${body.token}` },
    });
    const channels = await chRes.json();
    const channelId = channels[0].id;

    // Reload so the sidebar picks up the server, then enter the channel.
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(800);

    return { token: body.token, user: body.user, serverId: server.id, channelId, inviteCode };
}

function pasteFiles(page: any, files: { name: string; mime: string; b64: string }[]) {
    return page.evaluate((files) => {
        const dt = new DataTransfer();
        for (const f of files) {
            const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
            dt.items.add(new File([bytes], f.name, { type: f.mime }));
        }
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        document.getElementById('message-input').dispatchEvent(ev);
    }, files);
}

test.describe('Paste to upload', () => {

    test('pasting an image opens the upload modal with a preview', async ({ page }) => {
        const { } = await registerAndSetupServer(page);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });

        await pasteFiles(page, [{ name: 'pasted.png', mime: 'image/png', b64: PNG_B64 }]);

        const modal = page.locator('#upload-modal');
        await expect(modal).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#upload-file-info')).toContainText('pasted.png');
        await expect(page.locator('#upload-preview img')).toBeVisible();
    });

    test('pasting multiple files shows Upload All (N) and gallery navigation', async ({ page }) => {
        const { } = await registerAndSetupServer(page);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });

        await pasteFiles(page, [
            { name: 'one.png', mime: 'image/png', b64: PNG_B64 },
            { name: 'two.png', mime: 'image/png', b64: PNG_B64 },
            { name: 'three.png', mime: 'image/png', b64: PNG_B64 },
        ]);

        await expect(page.locator('#upload-modal')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#confirm-upload')).toContainText('Upload All (3)');
        await expect(page.locator('.gallery-counter')).toContainText('1 / 3');
        await expect(page.locator('#gallery-next')).toBeEnabled();
        await expect(page.locator('#gallery-prev')).toBeDisabled();
    });

    test('pasting a file then uploading sends an encrypted file the other side decrypts', async ({ page, context }) => {
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();

        // User A: register + create server (via the shared helper).
        const setupA = await registerAndSetupServer(page);

        // User B: register through the UI, join A's server via invite.
        await pageB.goto(`${BASE}/login.html`);
        await pageB.waitForSelector('#show-register');
        await pageB.click('#show-register');
        await pageB.fill('#register-username', 'paste_b_' + Date.now());
        await pageB.fill('#register-password', 'password123');
        await pageB.fill('#register-confirm-password', 'password123');
        await pageB.click('#register-form button[type="submit"]');
        await pageB.waitForURL('**/index.html', { timeout: 15000 });
        await pageB.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        const tokenB = await pageB.evaluate(() => localStorage.getItem('token'));
        const joinRes = await pageB.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
            data: { code: setupA.inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // B enters the channel too.
        await pageB.goto(`${BASE}/index.html`);
        await pageB.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await pageB.click('.server-icon:not(.add-server)');
        await pageB.waitForSelector('.channel-item', { timeout: 10000 });
        await pageB.click('.channel-item >> nth=0');
        await pageB.waitForTimeout(800);

        await expect(page.locator('#message-input')).toBeEnabled({ timeout: 5000 });

        // A pastes + uploads.
        await pasteFiles(page, [{ name: 'paste-photo.png', mime: 'image/png', b64: PNG_B64 }]);
        await expect(page.locator('#upload-modal')).toBeVisible({ timeout: 5000 });
        await page.click('#confirm-upload');
        await expect(page.locator('#upload-modal')).not.toBeVisible({ timeout: 20000 });

        // B sees the file message (decrypted locally).
        await expect(pageB.locator('.file-name')).toBeVisible({ timeout: 20000 });
        const texts = await pageB.locator('.file-name').allTextContents();
        expect(texts.some((t) => t.toLowerCase().includes('paste-photo.png'))).toBeTruthy();

        await pageB.close();
        await ctxB.close();
    });

    test('pasting non-image types (PDF, octet-stream, plain text file) all reach the modal', async ({ page }) => {
        const { } = await registerAndSetupServer(page);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });

        const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF').toString('base64');
        await pasteFiles(page, [
            { name: 'doc.pdf', mime: 'application/pdf', b64: PDF_B64 },
            { name: 'blob.bin', mime: 'application/octet-stream', b64: Buffer.from([0, 1, 2, 3, 4]).toString('base64') },
            { name: 'notes.txt', mime: 'text/plain', b64: Buffer.from('hello world').toString('base64') },
        ]);

        await expect(page.locator('#upload-modal')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#confirm-upload')).toContainText('Upload All (3)');
        await expect(page.locator('#upload-file-info')).toContainText('doc.pdf');
        await page.click('#gallery-next');
        await expect(page.locator('#upload-file-info')).toContainText('blob.bin');
        await page.click('#gallery-next');
        await expect(page.locator('#upload-file-info')).toContainText('notes.txt');
    });

    test('plain text paste is not intercepted (no modal)', async ({ page }) => {
        const { } = await registerAndSetupServer(page);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 5000 });
        await input.focus();

        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData('text/plain', 'hello pasted text');
            const ev = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            document.getElementById('message-input').dispatchEvent(ev);
        });
        await page.waitForTimeout(500);

        await expect(page.locator('#upload-modal')).not.toBeVisible();
        const val = await input.inputValue();
        expect(val).toBe('');
    });
});
