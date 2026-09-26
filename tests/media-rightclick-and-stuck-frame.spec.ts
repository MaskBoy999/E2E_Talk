import { test, expect } from '@playwright/test';

// Covers the message-media right-click menu:
//  - message context menu items render their icon (svg sprite <use>), not the
//    raw markup as text (the "broken icons" bug),
//  - file attachments get a Download + Copy file/image menu,
//  - a multi-file gallery renders a "Download all" button.
const BASE = 'https://localhost:3443';

async function registerUser(page: any, ts: number) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', 'mf_' + ts);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#message-list', { state: 'attached', timeout: 15000 });
}

// Right-click a selector and read the opened menu back.
async function rightClickAndReadMenu(page: any, selector: string) {
    await page.evaluate((sel: string) => {
        const menu = document.querySelector('.channel-context-menu');
        if (menu) menu.remove();
        const el = document.querySelector(sel);
        if (!el) throw new Error('missing ' + sel);
        el.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 40, clientY: 60,
        }));
    }, selector);
    return await page.evaluate(() => {
        const menu = document.querySelector('.channel-context-menu');
        if (!menu) return null;
        return Array.from(menu.querySelectorAll('.context-menu-item')).map((el: any) => ({
            text: (el.textContent || '').trim(),
            iconRef: el.querySelector('svg.ui-icon use')
                ? (el.querySelector('svg.ui-icon use').getAttribute('href') || '')
                : '',
            hasSvg: !!el.querySelector('svg.ui-icon'),
            label: el.querySelector('.context-menu-label') ? el.querySelector('.context-menu-label').textContent : null,
        }));
    });
}

test.describe('closing a camera/screen never leaves a stuck frame', () => {
    test('OFF clears the signal + tile surface, and late frames cannot resurrect it', async ({ page }) => {
        test.setTimeout(90000);
        await registerUser(page, Date.now());

        const res = await page.evaluate(() => {
            const VM = (window as any).VoiceManager;
            const S = VM._debug.state;
            const uid = 'peer-stuck';
            const errors: string[] = [];

            // Fake a live server voice room with that member's camera ON.
            S.connected = true;
            S.roomType = 'server';
            S.channelId = 'chan-1';
            S.serverId = 'srv-1';
            const rawKey = new Uint8Array(32);
            crypto.getRandomValues(rawKey);
            S.roomKeyB64 = E2ECrypto.arrayBufferToBase64(rawKey.buffer);
            S.members = {
                [uid]: { user_id: uid, username: 'peer', camera: true, screen: false, camera_mode: 'mesh', video_mode: 'mesh' },
            };

            // A live-looking mesh stream + the tile renderPopup() would mount.
            const canvas = document.createElement('canvas');
            canvas.width = 32; canvas.height = 32;
            const stream = canvas.captureStream(5);
            S.remoteStreams = { [uid]: { camera: stream } };
            const host = document.getElementById('voice-popup-members')!;
            host.innerHTML = '<div class="voice-member-row" data-uid="' + uid + '"><div class="voice-member-media">' +
                '<video class="remote-video-tile" data-uid="' + uid + '" data-kind="camera" data-self="0" autoplay playsinline muted style="display:block"></video>' +
                '</div></div>';
            const vid: any = host.querySelector('video.remote-video-tile')!;
            vid.srcObject = stream;
            // A cached relay frame for the same feed: the thing that used to be
            // re-injected onto the tile after the sender turned the feed off.
            S._relayVideoFrames = {};
            S._relayVideoFrames[uid + '_camera'] = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));

            // The member closes their camera. A FULL member-list snapshot is
            // the join/leave-broadcast path — it used to be the one that never
            // cleared the cached frame, so the next render re-injected it.
            try {
                VM.onWsMessage({
                    type: 'voice_members',
                    members: [{ user_id: uid, username: 'peer', camera: false, screen: false, camera_mode: 'mesh', video_mode: 'mesh' }],
                });
            } catch (e: any) { errors.push('members_snapshot: ' + e.message); }
            // ...and then the per-state path for good measure.
            try {
                VM.onWsMessage({
                    type: 'voice_member_update',
                    member: { user_id: uid, username: 'peer', camera: false, screen: false, camera_mode: 'mesh', video_mode: 'mesh' },
                });
            } catch (e: any) { errors.push('member_update: ' + e.message); }

            // A late in-flight relay frame for the closed feed arrives after the
            // state flip — it must be dropped, never painted.
            try {
                const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(S.roomKeyB64));
                const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
                const enc = E2ECrypto.aeadEncrypt(E2ECrypto.arrayBufferToBase64(jpeg.buffer), keyBytes);
                VM.onWsMessage({ type: 'voice_media_relay', from_user_id: uid, kind: 'camera', frame: { e: enc.ciphertext, n: enc.nonce } });
            } catch (e: any) { errors.push('late_relay: ' + e.message); }

            return {
                errors: errors,
                memberCamera: S.members[uid] ? S.members[uid].camera : null,
                cachedFrame: S._relayVideoFrames[uid + '_camera'] || null,
                cachedKeys: Object.keys(S._relayVideoFrames),
                relayImgs: document.querySelectorAll('img.relay-video[data-uid="' + uid + '"][data-kind="camera"]').length,
                tiles: Array.from(document.querySelectorAll('video.remote-video-tile[data-uid="' + uid + '"][data-kind="camera"]'))
                    .map((v: any) => ({ display: v.style.display, hasStream: !!v.srcObject })),
            };
        });
        console.log('STUCK-FRAME STATE:', JSON.stringify(res));
        expect(res.memberCamera).toBe(false);
        // The cached relay frame is gone, so no render pass can re-inject it.
        expect(res.cachedFrame).toBeNull();
        expect(res.cachedKeys).not.toContain('peer-stuck_camera');
        // The late frame was dropped instead of painting a tile.
        expect(res.relayImgs).toBe(0);
        // Every remaining surface for the feed is hidden with its decoder off —
        // the frozen-last-frame bug.
        for (const t of res.tiles) {
            expect(t.display).toBe('none');
            expect(t.hasStream).toBe(false);
        }
    });

    test('a fullscreened feed that gets closed leaves no frozen tile behind', async ({ page }) => {
        test.setTimeout(90000);
        await registerUser(page, Date.now());
        const uid = 'peer-fs';

        // Enter the room with the member's camera ON and render the real popup
        // row (which wires click → tile fullscreen).
        const entered = await page.evaluate((uid: string) => {
            const VM = (window as any).VoiceManager;
            const S = VM._debug.state;
            S.connected = true;
            S.roomType = 'server';
            S.channelId = 'chan-1';
            S.serverId = 'srv-1';
            S.channelName = 'general';
            S.members = {
                [uid]: { user_id: uid, username: 'peer', camera: true, screen: false, camera_mode: 'mesh', video_mode: 'mesh' },
            };
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 48;
            S.remoteStreams = { [uid]: { camera: canvas.captureStream(5) } };
            // The member list must be laid out for the tile to get its stream
            // (attachRemoteVideo refuses to attach to a hidden tile).
            const popup = document.getElementById('voice-popup')!;
            popup.style.display = 'flex';
            VM.onWsMessage({ type: 'voice_members', members: [S.members[uid]] });
            const tile: any = document.querySelector('video.remote-video-tile[data-uid="' + uid + '"][data-kind="camera"]');
            if (!tile) return { tile: false };
            // Click-to-fullscreen (the same handler a real click hits).
            tile.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { tile: true, hasStream: !!tile.srcObject, inWrap: !!tile.closest('.voice-fs-wrap') };
        }, uid);
        console.log('FULLSCREEN ENTER:', JSON.stringify(entered));
        expect(entered.tile).toBe(true);
        expect(entered.hasStream).toBe(true);
        expect(entered.inWrap).toBe(true);

        // The member closes their camera while we are fullscreened.
        await page.evaluate((uid: string) => {
            const VM = (window as any).VoiceManager;
            VM.onWsMessage({
                type: 'voice_member_update',
                member: { user_id: uid, username: 'peer', camera: false, screen: false, camera_mode: 'mesh', video_mode: 'mesh' },
            });
        }, uid);
        await page.waitForTimeout(600);

        const after = await page.evaluate((uid: string) => {
            const surfaces = Array.from(document.querySelectorAll(
                'video.remote-video-tile[data-uid="' + uid + '"][data-kind="camera"], img.relay-video[data-uid="' + uid + '"][data-kind="camera"]'
            )) as any[];
            return {
                total: surfaces.length,
                visible: surfaces.filter((el) => el.offsetParent !== null).length,
                withStream: surfaces.filter((el) => !!el.srcObject).length,
                wraps: document.querySelectorAll('.voice-fs-wrap').length,
            };
        }, uid);
        console.log('AFTER CLOSING A FULLSCREENED FEED:', JSON.stringify(after));
        // Nothing for that feed may remain on screen — and no leftover
        // fullscreen wrapper holding a frozen frame.
        expect(after.visible).toBe(0);
        expect(after.withStream).toBe(0);
        expect(after.wraps).toBe(0);
    });
});

test.describe('message + attachment right-click menus', () => {
    test('message menu renders real icons; attachments offer copy/download; gallery has Download all', async ({ page }) => {
        test.setTimeout(90000);
        const ts = Date.now();
        await registerUser(page, ts);

        // 1) Every icon referenced by the message menu exists in the inline
        //    sprite (so the <use> can actually resolve to a glyph).
        await page.evaluate(() => {
            const list = document.getElementById('message-list')!;
            list.innerHTML = '<div class="message" data-message-id="m-test" data-sender-id="someone-else">' +
                '<div class="text">hello</div></div>';
        });
        const items = await rightClickAndReadMenu(page, '.message[data-message-id="m-test"]');
        expect(items).not.toBeNull();
        const labels = (items || []).map((i: any) => i.text);
        console.log('MESSAGE MENU:', JSON.stringify(items));
        expect(labels).toContain('Reply');
        expect(labels).toContain('Copy Text');
        expect(labels).toContain('Copy Message Link');
        for (const it of items || []) {
            // No item may leak raw markup into its visible text.
            expect(it.text).not.toContain('<svg');
            expect(it.text).not.toContain('<use');
        }
        const replyItem = (items || []).find((i: any) => i.text === 'Reply');
        expect(replyItem).toBeTruthy();
        expect(replyItem.hasSvg).toBe(true);
        expect(replyItem.iconRef).toBe('#icon-reply');
        expect(replyItem.label).toBe('Reply');
        const spriteOk = await page.evaluate(() => !!document.getElementById('icon-reply'));
        expect(spriteOk).toBe(true);

        // 2) A file attachment gets Download + Copy file/image (image mime).
        await page.evaluate(() => {
            const list = document.getElementById('message-list')!;
            list.innerHTML = '<div class="message" data-message-id="m-file" data-sender-id="someone-else">' +
                '<div class="file-card" data-file-id="file-1" data-file-key="KEY" data-file-name="photo.jpg"' +
                ' data-file-mime="image/jpeg" data-file-size="2048">photo</div></div>';
        });
        const imgItems = await rightClickAndReadMenu(page, '.file-card[data-file-id="file-1"]');
        console.log('IMAGE ATTACHMENT MENU:', JSON.stringify(imgItems));
        expect(imgItems).not.toBeNull();
        expect(imgItems!.length).toBe(2);
        expect(imgItems![0].text).toContain('Download photo.jpg');
        // The menu draws its glyphs from the icon sprite, so the label is the
        // plain name (this expectation still carried the old emoji prefix).
        expect(imgItems![1].text).toBe('Copy image');
        expect(imgItems![1].iconRef).toBe('#icon-image');

        // Non-image file → "Copy file".
        await page.evaluate(() => {
            const list = document.getElementById('message-list')!;
            list.innerHTML = '<div class="message" data-message-id="m-zip" data-sender-id="someone-else">' +
                '<div class="file-card" data-file-id="file-2" data-file-key="KEY" data-file-name="notes.pdf"' +
                ' data-file-mime="application/pdf" data-file-size="4096">notes</div></div>';
        });
        const docItems = await rightClickAndReadMenu(page, '.file-card[data-file-id="file-2"]');
        console.log('DOC ATTACHMENT MENU:', JSON.stringify(docItems));
        // Same as the image case: the glyph is an icon, so the label is plain.
        expect(docItems![1].text).toBe('Copy file');
        expect(docItems![1].iconRef).toBe('#icon-clipboard');

        // 3) A multi-file gallery renders the "Download all" button and the
        //    click wiring is present (the zip path itself is covered by the
        //    decrypt helpers, which need real uploads).
        const gallery = await page.evaluate(() => {
            const files = [
                { file_id: 'a', file_key: 'k1', filename: 'one.png', file_size: 100, mime_type: 'image/png' },
                { file_id: 'b', file_key: 'k2', filename: 'two.pdf', file_size: 200, mime_type: 'application/pdf' },
                { file_id: 'c', file_key: 'k3', filename: 'three.txt', file_size: 300, mime_type: 'text/plain' },
            ];
            const html = (window as any).buildMultiFileCardHtml(files);
            const host = document.getElementById('message-list')!;
            host.innerHTML = '<div class="message" data-message-id="m-gallery" data-sender-id="someone-else">' + html + '</div>';
            const btn = host.querySelector('.msg-gallery-download-all');
            return {
                html: html,
                hasBtn: !!btn,
                btnText: btn ? (btn.textContent || '').trim() : '',
                btnIcon: btn ? !!btn.querySelector('use[href="#icon-download"]') : false,
            };
        });
        console.log('GALLERY:', JSON.stringify({ hasBtn: gallery.hasBtn, btnText: gallery.btnText, btnIcon: gallery.btnIcon }));
        expect(gallery.hasBtn).toBe(true);
        expect(gallery.btnText).toBe('Download all');
        expect(gallery.btnIcon).toBe(true);
        // Single-file payloads stay a plain card (no gallery, no download-all).
        const single = await page.evaluate(() =>
            (window as any).buildMultiFileCardHtml([
                { file_id: 'a', file_key: 'k1', filename: 'one.png', file_size: 100, mime_type: 'image/png' },
            ]));
        expect(single).not.toContain('msg-gallery-download-all');
    });
});
