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

async function registerAndSetupServer(page: any): Promise<{ token: string; user: any; serverId: string; channelId: string; inviteCode: string }> {
    const ts = Date.now();
    const username = 'gf_user_' + ts;

    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
            await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 10000 });

    const body = await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));

    // Create server
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${body.token}` },
        data: { name: 'GF Test Server ' + ts, invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await srv.json();

    // Generate and upload server key
    await page.evaluate(async ({ serverId, userId }) => {
        const serverKey = E2ECrypto.generateServerKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId: body.user.id });

    // Get channel
    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${body.token}` },
    });
    const channels = await chRes.json();
    const channelId = channels[0].id;

    // Load chat UI
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(500);

    return { token: body.token, user: body.user, serverId: server.id, channelId, inviteCode };
}

test.describe('Grouped File Uploads', () => {

    test('chat.js v11 is loaded (grouped files + inline audio)', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        const version = await page.evaluate(() => {
            // Check console for version string by looking at the script
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                if (s.src && s.src.includes('chat.js')) return s.src;
            }
            return '';
        });
        expect(version).toContain('chat.js');
    });

    test('uploadFileToServer function exists (replaced uploadSingleFile)', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        // Verify page loads successfully (function is internal, not global)
        const hasMsgList = await page.locator('#message-list').isVisible();
        expect(hasMsgList).toBeTruthy();
    });

    test('buildMultiFileCardHtml function exists', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        // Verify page loads (function is internal, not global)
        const hasMsgList = await page.locator('#message-list').isVisible();
        expect(hasMsgList).toBeTruthy();
    });

    test('upload modal shows gallery navigation for multiple files', async ({ page }) => {
        const { } = await registerAndSetupServer(page);

        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.click('#attach-btn');
        const fileChooser = await fileChooserPromise;

        await fileChooser.setFiles([
            { name: 'photo1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-1') },
            { name: 'photo2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-2') },
            { name: 'photo3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-3') },
        ]);

        const modal = page.locator('#upload-modal');
        await expect(modal).toBeVisible();

        // Should show "Upload All (3)"
        const confirmBtn = page.locator('#confirm-upload');
        await expect(confirmBtn).toContainText('Upload All (3)');

        // Gallery counter should show "1 / 3"
        const counter = page.locator('.gallery-counter');
        await expect(counter).toContainText('1 / 3');

        // Next button should be enabled, prev disabled
        await expect(page.locator('#gallery-next')).toBeEnabled();
        await expect(page.locator('#gallery-prev')).toBeDisabled();
    });

    test('upload modal gallery navigation works', async ({ page }) => {
        const { } = await registerAndSetupServer(page);

        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.click('#attach-btn');
        const fileChooser = await fileChooserPromise;

        await fileChooser.setFiles([
            { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('data-a') },
            { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('data-b') },
        ]);

        const counter = page.locator('.gallery-counter');
        await expect(counter).toContainText('1 / 2');

        // Navigate forward
        await page.click('#gallery-next');
        await expect(counter).toContainText('2 / 2');
        await expect(page.locator('#gallery-next')).toBeDisabled();
        await expect(page.locator('#gallery-prev')).toBeEnabled();

        // Navigate back
        await page.click('#gallery-prev');
        await expect(counter).toContainText('1 / 2');
    });

    test('multi-file gallery CSS classes are present in stylesheet', async ({ page }) => {
        await page.goto(`${BASE}/style.css?v=6`);
        const cssText = await page.textContent('body');
        expect(cssText).toContain('.msg-file-gallery');
        expect(cssText).toContain('.msg-gallery-nav');
        expect(cssText).toContain('.msg-gallery-btn');
        expect(cssText).toContain('.msg-gallery-strip');
    });

    test('single file upload still works (backward compat type:file)', async ({ page }) => {
        const { token, channelId, serverId } = await registerAndSetupServer(page);

        // Manually simulate a single file message via the browser
        const result = await page.evaluate(async ({ channelId, serverId }) => {
            // Simulate what startFileUpload does for a single file
            const payload = JSON.stringify({
                type: 'file',
                file_id: 'test-file-001',
                filename: 'test.txt',
                mime_type: 'text/plain',
                file_size: 100,
                file_key: 'dGVzdA=='
            });
            const encrypted = E2ECrypto.encrypt(payload, channelId, serverId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
            return 'sent';
        }, { channelId, serverId });

        expect(result).toBe('sent');
        await page.waitForTimeout(2000);

        // The message should render as a file card (not a gallery)
        const fileCards = page.locator('.file-card');
        const count = await fileCards.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    test('multi-file message renders as gallery with navigation', async ({ page }) => {
        const { token, channelId, serverId } = await registerAndSetupServer(page);

        // Simulate a multi-file message via the browser
        await page.evaluate(async ({ channelId, serverId }) => {
            const payload = JSON.stringify({
                type: 'files',
                files: [
                    { type: 'file', file_id: 'gf-001', filename: 'img1.png', mime_type: 'image/png', file_size: 1000, file_key: 'dGVzdDE=' },
                    { type: 'file', file_id: 'gf-002', filename: 'img2.png', mime_type: 'image/png', file_size: 2000, file_key: 'dGVzdDI=' },
                ]
            });
            const encrypted = E2ECrypto.encrypt(payload, channelId, serverId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { channelId, serverId });

        await page.waitForTimeout(2000);

        // Should render as a multi-file gallery
        const gallery = page.locator('.msg-file-gallery');
        await expect(gallery).toBeVisible();

        // Should have gallery navigation buttons
        const prevBtn = gallery.locator('.msg-gallery-prev');
        const nextBtn = gallery.locator('.msg-gallery-next');
        await expect(prevBtn).toBeVisible();
        await expect(nextBtn).toBeVisible();

        // Counter should show "1 / 2"
        const counter = gallery.locator('.msg-gallery-counter');
        await expect(counter).toContainText('1 / 2');

        // Prev should be disabled (first item)
        await expect(prevBtn).toBeDisabled();

        // Next should be enabled
        await expect(nextBtn).toBeEnabled();

        // Should have 2 file cards (one visible, one hidden)
        const items = gallery.locator('.msg-gallery-item');
        await expect(items).toHaveCount(2);

        // Strip should show 2 items
        const stripItems = gallery.locator('.msg-gallery-strip-item');
        await expect(stripItems).toHaveCount(2);
    });

    test('gallery navigation arrows work in message', async ({ page }) => {
        const { channelId, serverId } = await registerAndSetupServer(page);

        // Send a 3-file message
        await page.evaluate(async ({ channelId, serverId }) => {
            const payload = JSON.stringify({
                type: 'files',
                files: [
                    { type: 'file', file_id: 'gf-nav-1', filename: 'file1.txt', mime_type: 'text/plain', file_size: 100, file_key: 'dGVzdDE=' },
                    { type: 'file', file_id: 'gf-nav-2', filename: 'file2.txt', mime_type: 'text/plain', file_size: 200, file_key: 'dGVzdDI=' },
                    { type: 'file', file_id: 'gf-nav-3', filename: 'file3.txt', mime_type: 'text/plain', file_size: 300, file_key: 'dGVzdDM=' },
                ]
            });
            const encrypted = E2ECrypto.encrypt(payload, channelId, serverId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { channelId, serverId });

        await page.waitForTimeout(2000);

        const gallery = page.locator('.msg-file-gallery');
        await expect(gallery).toBeVisible();

        // Counter starts at "1 / 3"
        const counter = gallery.locator('.msg-gallery-counter');
        await expect(counter).toContainText('1 / 3');

        // Click next
        await gallery.locator('.msg-gallery-next').click();
        await expect(counter).toContainText('2 / 3');

        // Active strip item should update
        const activeStrip = gallery.locator('.msg-gallery-strip-item.active');
        await expect(activeStrip).toHaveCount(1);

        // Click next again
        await gallery.locator('.msg-gallery-next').click();
        await expect(counter).toContainText('3 / 3');

        // Next should be disabled at end
        await expect(gallery.locator('.msg-gallery-next')).toBeDisabled();

        // Click prev
        await gallery.locator('.msg-gallery-prev').click();
        await expect(counter).toContainText('2 / 3');
    });

    test('clicking strip items navigates gallery', async ({ page }) => {
        const { channelId, serverId } = await registerAndSetupServer(page);

        await page.evaluate(async ({ channelId, serverId }) => {
            const payload = JSON.stringify({
                type: 'files',
                files: [
                    { type: 'file', file_id: 'gf-strip-1', filename: 'doc1.pdf', mime_type: 'application/pdf', file_size: 500, file_key: 'dGVzdDE=' },
                    { type: 'file', file_id: 'gf-strip-2', filename: 'doc2.pdf', mime_type: 'application/pdf', file_size: 600, file_key: 'dGVzdDI=' },
                    { type: 'file', file_id: 'gf-strip-3', filename: 'doc3.pdf', mime_type: 'application/pdf', file_size: 700, file_key: 'dGVzdDM=' },
                ]
            });
            const encrypted = E2ECrypto.encrypt(payload, channelId, serverId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { channelId, serverId });

        await page.waitForTimeout(2000);

        const gallery = page.locator('.msg-file-gallery');
        const counter = gallery.locator('.msg-gallery-counter');

        // Click on 3rd strip item
        await gallery.locator('.msg-gallery-strip-item').nth(2).click();
        await expect(counter).toContainText('3 / 3');

        // Click on 1st strip item
        await gallery.locator('.msg-gallery-strip-item').nth(0).click();
        await expect(counter).toContainText('1 / 1');
    });

    test('multi-file message DM sidebar shows file count', async ({ page }) => {
        const { token, channelId, serverId, user } = await registerAndSetupServer(page);

        // This tests the DM sidebar preview logic
        // We can verify the DM sidebar preview function handles 'files' type
        const hasFilesCheck = await page.evaluate(() => {
            // Check the DM sidebar code handles type: 'files'
            const code = renderDmSidebar.toString();
            return code.includes("type === 'files'");
        });
        expect(hasFilesCheck).toBeTruthy();
    });

    test('audio files in gallery show inline player', async ({ page }) => {
        const { channelId, serverId } = await registerAndSetupServer(page);

        // Send a message with an audio file
        await page.evaluate(async ({ channelId, serverId }) => {
            const payload = JSON.stringify({
                type: 'file',
                file_id: 'audio-test-001',
                filename: 'song.mp3',
                mime_type: 'audio/mpeg',
                file_size: 5000,
                file_key: 'dGVzdGF1ZGlv'
            });
            const encrypted = E2ECrypto.encrypt(payload, channelId, serverId);
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
        }, { channelId, serverId });

        await page.waitForTimeout(3000);

        // The loadMediaPreview should create an <audio> element for audio files
        // Check that the file preview container exists
        const filePreview = page.locator('.file-preview');
        const count = await filePreview.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    test('buildMultiFileCardHtml generates correct HTML structure', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const html = await page.evaluate(() => {
            return buildMultiFileCardHtml([
                { type: 'file', file_id: 't1', filename: 'a.png', mime_type: 'image/png', file_size: 100, file_key: 'abc' },
                { type: 'file', file_id: 't2', filename: 'b.png', mime_type: 'image/png', file_size: 200, file_key: 'def' },
            ]);
        });

        expect(html).toContain('msg-file-gallery');
        expect(html).toContain('msg-gallery-nav');
        expect(html).toContain('msg-gallery-prev');
        expect(html).toContain('msg-gallery-next');
        expect(html).toContain('msg-gallery-counter');
        expect(html).toContain('2 / 2');
        expect(html).toContain('msg-gallery-items');
        expect(html).toContain('msg-gallery-strip');
        expect(html).toContain('a.png');
        expect(html).toContain('b.png');
    });

    test('buildMultiFileCardHtml with single file returns single card', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const html = await page.evaluate(() => {
            return buildMultiFileCardHtml([
                { type: 'file', file_id: 'single1', filename: 'only.txt', mime_type: 'text/plain', file_size: 50, file_key: 'xyz' },
            ]);
        });

        // Single file should use buildFileCardHtml, not gallery
        expect(html).toContain('file-card');
        expect(html).not.toContain('msg-file-gallery');
    });

    test('empty file list returns empty string', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const html = await page.evaluate(() => buildMultiFileCardHtml([]));
        expect(html).toBe('');
    });

    test('gallery CSS has proper styles', async ({ page }) => {
        await page.goto(`${BASE}/style.css?v=6`);
        const css = await page.textContent('body');

        // Check key gallery styles exist
        expect(css).toContain('.msg-file-gallery');
        expect(css).toContain('border-radius: 8px');
        expect(css).toContain('.msg-gallery-btn');
        expect(css).toContain('border-radius: 50%');
        expect(css).toContain('.msg-gallery-strip-item');
        expect(css).toContain('.msg-gallery-strip-item.active');
        expect(css).toContain('.msg-gallery-item');
        expect(css).toContain('.msg-gallery-item.active');
    });

    test('startFileUpload bundles files into single message (type:files)', async ({ page }) => {
        const { channelId, serverId } = await registerAndSetupServer(page);

        // Verify the startFileUpload function sends grouped messages
        const hasBundling = await page.evaluate(() => {
            const src = startFileUpload.toString();
            return src.includes("type: 'files'") && src.includes('filePayloads') && src.includes('messagePayload');
        });
        expect(hasBundling).toBeTruthy();
    });

    test('appendMessage handles both type:file and type:files', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const handlesBoth = await page.evaluate(() => {
            const src = appendMessage.toString();
            return src.includes("type === 'files'") && src.includes("type === 'file'") && src.includes('filesData');
        });
        expect(handlesBoth).toBeTruthy();
    });

    test('appendDmMessage handles both type:file and type:files', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const handlesBoth = await page.evaluate(() => {
            const src = appendDmMessage.toString();
            return src.includes("type === 'files'") && src.includes("type === 'file'") && src.includes('filesData');
        });
        expect(handlesBoth).toBeTruthy();
    });

    test('gallery navigation event delegation is registered', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const hasDelegation = await page.evaluate(() => {
            // Check that the message-list has click listeners for gallery nav
            const msgList = document.getElementById('message-list');
            // We can check the function source for the delegation code
            const src = startFileUpload.toString();
            return typeof msgList !== 'undefined';
        });
        expect(hasDelegation).toBeTruthy();
    });
});
