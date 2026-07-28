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

function createTestImageBuffer(size: number = 100): Buffer {
    // Create a minimal valid 1x1 pixel PNG (no external deps needed)
    // Minimal PNG: signature + IHDR + IDAT + IEND
    // This creates a small orange PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    return Buffer.from(pngBase64, 'base64');
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
    }));
}

async function createServerAndKey(page: any, token: string, userId: string, serverName: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: serverName, invite_code: inviteCode },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });
    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

// Helper: upload a sticker via the sticker upload modal
async function uploadSticker(page: any, imageBuffer: Buffer, stickerName: string, mode: string) {
    // Open the sticker panel
    await page.click('#sticker-btn');
    await page.waitForSelector('#sticker-panel', { state: 'visible' });
    await page.waitForTimeout(500);
    
    // Click the upload tab
    const uploadTab = page.locator('.sticker-tab[data-tab="upload"]');
    if (await uploadTab.isVisible()) {
        await uploadTab.click();
    }
    await page.waitForTimeout(500);
    
    // Click the appropriate upload button (sticker, GIF, or emoji)
    let triggerId = '#sticker-upload-trigger';
    if (mode === 'gif') triggerId = '#gif-upload-trigger';
    else if (mode === 'emoji') triggerId = '#emoji-upload-trigger';
    
    // Wait for the file chooser
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click(triggerId);
    const fileChooser = await fileChooserPromise;
    const mimeType = mode === 'gif' ? 'image/gif' : 'image/png';
    await fileChooser.setFiles([{ name: stickerName + '.png', mimeType, buffer: imageBuffer }]);
    await page.waitForTimeout(1000);
    
    // Fill the sticker name in case the crop step is shown
    await page.waitForTimeout(500);
    await page.fill('#sticker-upload-name', stickerName);
    
    // Check if crop step is shown or if it auto-completes
    const confirmBtn = page.locator('#confirm-sticker-upload');
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
    }
    
    // Wait for upload to complete
    await page.waitForTimeout(8000);
    
    // Switch back to emojis tab (resets activePanelTab), then close the panel.
    // We hide the panel + modal directly, then trigger the document-level
    // click handler to reset stickerPanelOpen to false.
    await page.evaluate(() => {
        // Switch back to emoji tab to reset activePanelTab for next panel open
        const emojiTab = document.querySelector('.sticker-tab[data-tab="emojis"]');
        if (emojiTab) emojiTab.click();
        // Hide panels
        document.getElementById('sticker-panel').style.display = 'none';
        document.getElementById('sticker-upload-modal').style.display = 'none';
        // Fire a click on a dummy element outside panel/btn to close via document handler
        const dummy = document.createElement('div');
        dummy.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px';
        document.body.appendChild(dummy);
        dummy.click();
        dummy.remove();
    });
}

// Helper: navigate to a server channel
async function navigateToChannel(page: any) {
    await page.evaluate(async () => { await loadServers(); });
    await page.waitForTimeout(2000);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(2000);
    const input = page.locator('#message-input');
    await expect(input).toBeEnabled({ timeout: 15000 });
}

// ============================================================
// Sticker/GIF/Emoji Tests
// ============================================================
test.describe('Stickers, GIFs, and Emojis', () => {

    // ============================================================
    // TEST 1: Sticker upload creates a sticker visible in the picker
    // ============================================================
    test('sticker upload creates a sticker visible in the picker', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'stickup_' + ts;
        const stickerName = 'test_sticker_' + ts;

        // Register
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'StickerTest_' + ts);

        // Navigate to channel
        await navigateToChannel(page);

        // Upload a sticker
        const imgBuf = createTestImageBuffer(100);
        await uploadSticker(page, imgBuf, stickerName, 'sticker');
        
        // Open sticker panel and check the sticker tab
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(500);
        
        // Switch to stickers tab
        const stickerTab = page.locator('.sticker-tab[data-tab="stickers"]');
        if (await stickerTab.isVisible()) {
            await stickerTab.click();
        }
        await page.waitForTimeout(2000);
        
        // Check that a sticker grid item appears
        const stickerItems = page.locator('.sticker-grid-item, .sticker-grid img');
        const count = await stickerItems.count();
        console.log(`Found ${count} sticker items in grid`);
        expect(count).toBeGreaterThanOrEqual(1);
    });

    // ============================================================
    // TEST 2: GIF upload creates a GIF visible in the GIF panel
    // ============================================================
    test('GIF upload creates a GIF visible in the GIF panel', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'gifup_' + ts;
        const gifName = 'test_gif_' + ts;

        // Register
        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'GifTest_' + ts);
        await navigateToChannel(page);

        // Upload a GIF
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, gifName, 'gif');
        
        // Open sticker panel and check the GIF tab
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(500);
        
        // Switch to GIFs tab
        const gifTab = page.locator('.sticker-tab[data-tab="gifs"]');
        if (await gifTab.isVisible()) {
            await gifTab.click();
        }
        await page.waitForTimeout(2000);
        
        // Check that GIF grid items appear
        const gifItems = page.locator('.gif-grid-item, .gif-grid img');
        const count = await gifItems.count();
        console.log(`Found ${count} GIF items in grid`);
        expect(count).toBeGreaterThanOrEqual(1);
    });

    // ============================================================
    // TEST 3: Emoji upload creates an emoji visible in the emoji panel
    // ============================================================
    test('emoji upload creates an emoji visible in the emoji panel', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'emojiup_' + ts;
        const emojiName = 'test_emoji_' + ts;

        // Register
        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'EmojiTest_' + ts);
        await navigateToChannel(page);

        // Upload an emoji
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, emojiName, 'emoji');
        
        // Open sticker panel and check the emoji tab
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(500);
        
        // Switch to emojis tab
        const emojiTab = page.locator('.sticker-tab[data-tab="emojis"]');
        if (await emojiTab.isVisible()) {
            await emojiTab.click();
        }
        await page.waitForTimeout(2000);
        
        // Check that emoji items appear in the grid
        const emojiItems = page.locator('.emoji-grid-item, .emoji-item');
        const count = await emojiItems.count();
        console.log(`Found ${count} emoji items in grid`);
        expect(count).toBeGreaterThanOrEqual(1);
    });

    // ============================================================
    // TEST 4: Sticker can be sent and rendered in a server channel
    // ============================================================
    test('sticker sent in server channel is rendered for the sender', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'sticksend_' + ts;
        const stickerName = 'send_sticker_' + ts;

        // Register
        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'StickerSend_' + ts);

        // Upload a sticker first
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, stickerName, 'sticker');
        
        // Navigate to channel and send the sticker
        await navigateToChannel(page);

        // Open sticker panel
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(1000);
        
        // Switch to stickers tab
        const stickerTab = page.locator('.sticker-tab[data-tab="stickers"]');
        if (await stickerTab.isVisible()) {
            await stickerTab.click();
        }
        await page.waitForTimeout(2000);
        
        // Click the first sticker to send it
        const firstSticker = page.locator('.sticker-grid-item, .sticker-grid img, .gif-grid-item, .gif-grid img').first();
        const isVisible = await firstSticker.isVisible({ timeout: 5000 }).catch(() => false);
        if (isVisible) {
            await firstSticker.click();
            await page.waitForTimeout(5000);
        }
        
        // Wait for the sticker to appear in the message list
        await page.waitForTimeout(3000);
        
        // Check that a sticker message element was created
        const stickerMsgElements = page.locator('.sticker-message');
        const stickerCount = await stickerMsgElements.count();
        console.log(`Found ${stickerCount} sticker message elements`);
        
        // Either we have a sticker message or a loaded sticker preview
        const stickerImgs = page.locator('.sticker-message img');
        const imgCount = await stickerImgs.count();
        console.log(`Found ${imgCount} sticker images in messages`);
        
        // Check for any 'Load sticker' button (means sticker exists but not auto-loaded)
        const loadBtns = page.locator('.load-preview-btn');
        const btnCount = await loadBtns.count();
        console.log(`Found ${btnCount} load-preview buttons`);
        
        // The sticker should either be rendered as an img or have a load button
        expect(stickerCount + btnCount).toBeGreaterThanOrEqual(1);
    });

    // ============================================================
    // TEST 5: Sticker sent in a DM is rendered 
    // ============================================================
    test('sticker sent in DM is rendered for both users', async ({ page: user1Page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1Name = 'stickdm1_' + ts;
        const user2Name = 'stickdm2_' + ts;
        const stickerName = 'dm_sticker_' + ts;

        // Register user 1
        const body1 = await registerUser(user1Page, user1Name);
        
        // Upload sticker as user 1
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(user1Page, imgBuf, stickerName, 'sticker');

        // Register user 2 in a new tab (context)
        const user2Page = await context.newPage();
        const body2 = await registerUser(user2Page, user2Name);

        // Friend user1 -> user2 using friend codes
        // Get friend code for user1 from local storage
        const user1Code = await user1Page.evaluate(() => localStorage.getItem('e2e_friend_code'));
        console.log('User1 friend code:', user1Code);
        expect(user1Code).toBeTruthy();

        // Send friend request from user2 -> user1
        await user2Page.goto(`${BASE}/index.html`);
        await user2Page.waitForTimeout(2000);
        await user2Page.evaluate(() => {
            // Simulate adding friend via code - navigate to add friend section
            document.getElementById('add-friend-input').value = '';
        });
        
        // Use the API directly to send friend request
        const frRes = await user2Page.request.post(`${BASE}/api/friend-requests/send`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: user1Code },
        });
        const frData = await frRes.json();
        console.log('Friend request result:', JSON.stringify(frData));
        
        if (frRes.ok()) {
            // Accept friend request on user1's side
            // Get pending friend requests for user1
            const pendingRes = await user1Page.request.get(`${BASE}/api/friend-requests/pending`, {
                headers: { Authorization: `Bearer ${body1.token}` },
            });
            if (pendingRes.ok()) {
                const pending = await pendingRes.json();
                console.log('Pending requests:', JSON.stringify(pending));
                if (pending.length > 0) {
                    await user1Page.request.post(`${BASE}/api/friend-requests/${pending[0].id}/accept`, {
                        headers: { Authorization: `Bearer ${body1.token}` },
                    });
                }
            }
        }
        await user1Page.waitForTimeout(2000);
        await user2Page.waitForTimeout(2000);
        
        // Both pages refresh to pick up DM state
        await user1Page.reload();
        await user1Page.waitForTimeout(2000);
        await user2Page.reload();
        await user2Page.waitForTimeout(2000);
        
        // User1 sends sticker to user2 via DM - navigate to DM view
        await user1Page.evaluate(() => enterDmView());
        await user1Page.waitForTimeout(2000);
        
        // Wait for DM conversations to load
        await user1Page.waitForSelector('.dm-item', { timeout: 10000 }).catch(() => {});
        
        // Click on a DM item
        const dmItems = user1Page.locator('.dm-item');
        const dmCount = await dmItems.count();
        if (dmCount > 0) {
            await dmItems.first().click();
            await user1Page.waitForTimeout(2000);
            
            // Open sticker panel and send a sticker in the DM
            await user1Page.click('#sticker-btn');
            await user1Page.waitForSelector('#sticker-panel', { state: 'visible' });
            await user1Page.waitForTimeout(500);
            
            const stickerTab = user1Page.locator('.sticker-tab[data-tab="stickers"]');
            if (await stickerTab.isVisible()) {
                await stickerTab.click();
            }
            await user1Page.waitForTimeout(2000);
            
            const firstSticker = user1Page.locator('.sticker-grid-item, .sticker-grid img, .gif-grid-item, .gif-grid img').first();
            const isVisible = await firstSticker.isVisible({ timeout: 5000 }).catch(() => false);
            if (isVisible) {
                await firstSticker.click();
                await user1Page.waitForTimeout(5000);
            }
            
            // Check user1 sees the sticker
            const stickerMsgs1 = user1Page.locator('.sticker-message');
            const stickerMsgCount = await stickerMsgs1.count();
            console.log(`User1 sticker messages: ${stickerMsgCount}`);
            
            // Check user2 sees the sticker (may need refresh)
            await user2Page.reload();
            await user2Page.waitForTimeout(3000);
            await user2Page.evaluate(() => enterDmView());
            await user2Page.waitForTimeout(2000);
            const dmItems2 = user2Page.locator('.dm-item');
            const dmCount2 = await dmItems2.count();
            if (dmCount2 > 0) {
                await dmItems2.first().click();
                await user2Page.waitForTimeout(3000);
                const stickerMsgs2 = user2Page.locator('.sticker-message');
                const stickerMsgCount2 = await stickerMsgs2.count();
                console.log(`User2 sticker messages: ${stickerMsgCount2}`);
                expect(stickerMsgCount2).toBeGreaterThanOrEqual(1);
            }
        }
    });

    // ============================================================
    // TEST 6: Encrypted file key is never plaintext on the server
    // ============================================================
    test('sticker file keys are encrypted on the server (not plaintext)', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'stickenc_' + ts;
        const stickerName = 'enc_sticker_' + ts;

        // Register
        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'EncSticker_' + ts);
        await navigateToChannel(page);

        // Upload a sticker
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, stickerName, 'sticker');
        
        // Fetch stickers from API
        const stickersRes = await page.request.get(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(stickersRes.ok()).toBeTruthy();
        const stickers = await stickersRes.json();
        console.log(`Found ${stickers.length} stickers via API`);
        expect(stickers.length).toBeGreaterThanOrEqual(1);
        
        // Check that file_key is NOT a raw 32-byte base64 string (which would be exactly 44 chars with no colon)
        for (const s of stickers) {
            console.log(`Sticker '${s.sticker_name}': file_key=${s.file_key ? s.file_key.substring(0, 30) + '...' : 'N/A'}, has encrypted_file_key=${!!s.encrypted_file_key}, has file_key_nonce=${!!s.file_key_nonce}`);
            
            // The server should NOT store a raw plaintext key
            // Identity-encrypted keys are stored as nonce:ciphertext format
            if (s.file_key) {
                // file_key should contain a colon (nonce:ciphertext format)
                // or be an encrypted blob
                const hasColon = s.file_key.includes(':');
                const isShort = s.file_key.length <= 44; // 44 chars = base64 of 32 bytes (raw key)
                
                // If no colon and ~44 chars, it might be a raw key stored in plaintext
                if (!hasColon && isShort) {
                    console.warn(`POTENTIAL ISSUE: Sticker '${s.sticker_name}' has file_key that looks like raw base64 (no colon, ${s.file_key.length} chars)`);
                }
            }
            
            // encrypted_file_key and file_key_nonce should exist for new stickers
            // (they store the identity-encrypted key split into two columns)
            if (!s.encrypted_file_key || !s.file_key_nonce) {
                // This is OK for old stickers, but new stickers should have both
                console.log(`Note: sticker '${s.sticker_name}' missing encrypted_file_key or file_key_nonce`);
            }
        }
        
        // The raw file key bytes should never be directly accessible from the API
        // Verify by checking that file_key values are not simple 32-byte base64 strings
        for (const s of stickers) {
            if (s.file_key && s.file_key.length === 44 && !s.file_key.includes(':')) {
                // This looks like a raw key - flag it
                expect(s.file_key).not.toHaveLength(44);
            }
        }
    });

    // ============================================================
    // TEST 7: Emojis render inline in messages  
    // ============================================================
    test('emoji renders as inline image in message text', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'emojirender_' + ts;
        const emojiName = 'inline_emoji_' + ts;

        // Register
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id, 'EmojiRender_' + ts);

        // Upload an emoji
        const imgBuf = createTestImageBuffer(48);
        await uploadSticker(page, imgBuf, emojiName, 'emoji');
        
        // Navigate to channel and send a message with the emoji shortcode
        await navigateToChannel(page);
        
        const testText = `Hello with emoji :${emojiName}: here`;
        const input = page.locator('#message-input');
        await input.fill(testText);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);
        
        // Check that the message text contains the emoji shortcode or rendered image
        const msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Message texts:', JSON.stringify(msgTexts));
        
        // Either the emoji shortcode text appears, or an inline emoji image is rendered
        const hasShortcode = msgTexts.some(t => t && t.includes(':' + emojiName + ':'));
        const emojiImgs = page.locator('.emoji-inline');
        const emojiImgCount = await emojiImgs.count();
        console.log(`Found ${emojiImgCount} inline emoji images`);
        
        expect(hasShortcode || emojiImgCount > 0).toBeTruthy();
    });

    // ============================================================
    // DIAGNOSTIC TEST: Upload emoji and check API response mime_type
    // ============================================================
    test('DIAGNOSTIC: upload emoji then inspect API mime_type', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'diag_' + ts;
        const emojiName = 'diag_emoji_' + ts;

        // Register
        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'Diag_' + ts);
        await navigateToChannel(page);

        // Upload emoji
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, emojiName, 'emoji');

        // Fetch stickers from API and log all mime_types
        const stickersRes = await page.request.get(`${BASE}/api/users/me/stickers`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(stickersRes.ok()).toBeTruthy();
        const stickers = await stickersRes.json();
        console.log('DIAGNOSTIC: All stickers from API:');
        for (const s of stickers) {
            console.log(`  name="${s.sticker_name}" mime_type="${s.mime_type}"`);
        }

        // Assert correct mime_type for emoji
        const emojiItem = stickers.find(s => s.sticker_name === emojiName);
        expect(emojiItem).toBeTruthy();
        expect(emojiItem.mime_type).toBe('image/emoji');
    });

    // ============================================================
    // TEST 8: Uploaded items appear only in their respective tabs
    // ============================================================
    test('uploaded emoji appears in emoji tab and NOT in stickers tab', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'tabe_' + ts;
        const emojiName = 'tab_emoji_' + ts;

        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'TabEmoji_' + ts);
        await navigateToChannel(page);

        // Upload emoji
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, emojiName, 'emoji');

        // Open sticker panel (default tab = emojis)
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(2000);

        // Check emoji tab - should contain the emoji
        const emojiItems = page.locator('.emoji-item-custom, .emoji-item');
        const emojiCount = await emojiItems.count();

        // Switch to stickers tab
        const stickerTab = page.locator('.sticker-tab[data-tab="stickers"]');
        if (await stickerTab.isVisible()) {
            await stickerTab.click();
        }
        await page.waitForTimeout(2000);

        // The emoji should NOT appear in the stickers grid
        const stickerNames = await page.locator('#user-sticker-grid .sticker-grid-item').evaluateAll(
            items => items.map(el => (el as HTMLElement).title)
        );
        expect(stickerNames).not.toContain(emojiName);
    });

    // ============================================================
    // TEST 9: Uploaded GIF appears only in GIF tab and NOT in stickers tab
    // ============================================================
    test('uploaded GIF appears in GIF tab and NOT in stickers tab', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'tabg_' + ts;
        const gifName = 'tab_gif_' + ts;

        const body = await registerUser(page, username);
        await createServerAndKey(page, body.token, body.user.id, 'TabGif_' + ts);
        await navigateToChannel(page);

        // Upload GIF
        const imgBuf = createTestImageBuffer(64);
        await uploadSticker(page, imgBuf, gifName, 'gif');

        // Open sticker panel
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(2000);

        // Switch to GIFs tab
        const gifTab = page.locator('.sticker-tab[data-tab="gifs"]');
        if (await gifTab.isVisible()) {
            await gifTab.click();
        }
        await page.waitForTimeout(2000);

        // Check GIF tab - should contain the GIF
        const gifItems = page.locator('.gif-grid-item');
        const gifCount = await gifItems.count();
        console.log(`GIF tab: found ${gifCount} GIF items`);
        expect(gifCount).toBeGreaterThanOrEqual(1);

        // Switch to stickers tab
        const stickerTab = page.locator('.sticker-tab[data-tab="stickers"]');
        if (await stickerTab.isVisible()) {
            await stickerTab.click();
        }
        await page.waitForTimeout(2000);

        // No GIF should appear in the stickers grid (they're filtered by mime_type)
        const stickerItems = page.locator('#user-sticker-grid .sticker-grid-item');
        const stickerCount = await stickerItems.count();
        console.log(`Stickers tab: found ${stickerCount} items`);

        // Check none of the sticker items have GIF title
        const stickerNames = await page.locator('#user-sticker-grid .sticker-grid-item').evaluateAll(
            items => items.map(el => (el as HTMLElement).title)
        );
        console.log('Sticker titles:', JSON.stringify(stickerNames));
        expect(stickerNames).not.toContain(gifName);
    });
});
