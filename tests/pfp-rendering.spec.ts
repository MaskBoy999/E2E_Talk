import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Profile Picture Rendering Across Message Types', () => {

    test.setTimeout(120000);

    test('text/forward/sticker/gif are grouped; files break the chain', async ({ page, context }) => {
        const ts = Date.now();
        const user1 = 'pfpa_' + ts;
        const user2 = 'pfpb_' + ts;

        // ── Register User A ──
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', user1);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        const body1 = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            hmacKey: localStorage.getItem('e2e_hmac_key'),
        }));
        expect(body1.token).toBeTruthy();

        // ── Register User B ──
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/login.html`);
        await page2.waitForSelector('#show-register');
        await page2.click('#show-register');
        await page2.fill('#register-username', user2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });
        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            hmacKey: localStorage.getItem('e2e_hmac_key'),
        }));
        expect(body2.token).toBeTruthy();

        // ── Make friends ──
        const code2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(code2).toBeTruthy();
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: code2 },
        });
        expect(fr.ok()).toBeTruthy();
        await page.waitForTimeout(500);

        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        expect(Array.isArray(incoming)).toBe(true);
        expect(incoming.length).toBe(1);
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();
        await page.waitForTimeout(1000);

        // ── Create DM channel ──
        const user2Id = body2.user.id;
        const dm = await page.request.post(`${BASE}/api/dm/${user2Id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        expect(dm.ok()).toBeTruthy();
        const dmChannel = await dm.json();
        const dmChannelId = dmChannel.id;

        // ── Upload a shared test file ──
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
            0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
            0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
            0x00, 0x00, 0x03, 0x00, 0x01, 0x34, 0x80, 0x59,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82,
        ]);
        const initRes = await page.request.post(`${BASE}/api/files/init`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { size: pngBytes.length, mime: 'image/png' },
        });
        expect(initRes.ok()).toBeTruthy();
        const { file_id: profileFileId } = await initRes.json();
        await page.request.fetch(`${BASE}/api/files/${profileFileId}/chunk/0`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/octet-stream' },
            data: pngBytes,
        });
        await page.request.post(`${BASE}/api/files/${profileFileId}/complete`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });

        // Compute HMAC'd sender_id for User A (matches production forward payloads)
        const mySenderId = body1.hmacKey
            ? await page.evaluate(({ key, id }: any) => {
                const w = window as any;
                return w.E2ECrypto.hmacHex(key, id);
            }, { key: body1.hmacKey, id: body1.user.id })
            : body1.user.id;

        // ── User A sends 5 DM messages ──
        // Each message uses its OWN fresh WebSocket connection to avoid stale WS issues.
        // The encryption happens in-page (E2ECrypto), then the WS is opened, authed, and
        // the dm_send is dispatched — all inside a single page.evaluate.

        async function sendDmAndWait(msgPayload: any) {
            await page.goto(`${BASE}/index.html`);
            const res = await page.evaluate(async ({ dmChannelId, otherUserId, otherUsername, payload }: any) => {
                const token = localStorage.getItem('token');
                if (!token) return 'NO_TOKEN';
                const kp = (window as any).E2ECrypto.getIdentityKeyPair();
                if (!kp) return 'NO_IDENTITY';
                const fetchRes = await fetch('/api/identity/' + otherUserId, {
                    headers: { Authorization: 'Bearer ' + token }
                });
                if (!fetchRes.ok) return 'KEY_FETCH_FAIL';
                const data = await fetchRes.json();
                if (!data.identity_public_key) return 'NO_PUB_KEY';
                const pubKey = new Uint8Array((window as any).E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
                const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const enc = (window as any).E2ECrypto.encryptDm(plaintext, dmChannelId, kp.privateKey, pubKey);

                // Create a fresh WebSocket connection for this message
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(protocol + '//' + window.location.host + '/ws');

                // Wait for WS to open
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => reject('WS_TIMEOUT'), 15000);
                    ws.onopen = () => { clearTimeout(timeout); resolve(); };
                    ws.onerror = () => { clearTimeout(timeout); reject('WS_ERROR'); };
                });

                // Wait for auth_ok response
                const authResult = await new Promise<string>((resolve, reject) => {
                    const timeout = setTimeout(() => reject('AUTH_TIMEOUT'), 10000);
                    ws.onmessage = (evt: any) => {
                        try {
                            const msg = JSON.parse(evt.data);
                            if (msg.type === 'auth_ok') {
                                clearTimeout(timeout);
                                resolve('AUTH_OK');
                            }
                        } catch (_) {}
                    };
                    ws.send(JSON.stringify({ type: 'auth', token }));
                });
                if (authResult !== 'AUTH_OK') return authResult;

                // Send the DM message
                ws.send(JSON.stringify({
                    type: 'dm_send',
                    dm_channel_id: dmChannelId,
                    encrypted_content: enc.ciphertext,
                    nonce: enc.nonce,
                    message_nonce: enc.messageNonce || null,
                }));

                // Wait briefly for the server to process, then close
                await new Promise(r => setTimeout(r, 500));
                ws.close();
                return 'SENT';
            }, { dmChannelId, otherUserId: user2Id, otherUsername: user2, payload: msgPayload });
            expect(res).toBe('SENT');
            // Poll until message is persisted in API
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 500));
                const checkRes = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
                    headers: { Authorization: `Bearer ${body1.token}` },
                });
                if (checkRes.ok) {
                    const msgs = await checkRes.json();
                    if (Array.isArray(msgs) && msgs.length > 0) break;
                }
            }
        }

        // Send 5 message types: text, forward, sticker, gif, file
        await sendDmAndWait('Hello from A! Plain text message.');
        await sendDmAndWait({
            type: 'forward',
            source_is_dm: false,
            source_message_id: 'fwd-001',
            source_server_id: 'test-srv',
            source_channel_id: 'test-ch',
            source_server_name: 'Test Server',
            source_channel_name: 'general',
            sender_username: user1,
            sender_id: mySenderId,
            sender_profile_pic_file_id: profileFileId,
            sender_profile_pic_file_key: 'dGVzdF9rZXk=',
            sender_color: '#ff6600',
            sender_border_color: '',
        });
        await sendDmAndWait({
            type: 'sticker',
            file_id: profileFileId,
            file_key: 'c3RpY2tlcl9rZXk=',
            mime_type: 'image/png',
        });
        await sendDmAndWait({
            type: 'gif',
            url: 'https://media.giphy.com/media/3o7abKhOpu0ixD1cms/giphy.gif',
            alt: 'Test GIF',
        });
        await sendDmAndWait({
            type: 'file',
            file_id: profileFileId,
            file_key: 'ZmlsZV9rZXk=',
            filename: 'test.png',
            mime_type: 'image/png',
            size: pngBytes.length,
        });

        // ── User A verifies messages ──
        await page.goto(`${BASE}/index.html`);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.evaluate(async ({ dmChannelId, uid, uname }: any) => {
            for (let i = 0; i < 50; i++) {
                if ((window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (typeof (window as any).selectDmChannel === 'function') {
                await (window as any).selectDmChannel(dmChannelId, uid, uname, null);
            }
        }, { dmChannelId, uid: user2Id, uname: user2 });
        await page.waitForTimeout(3000);

        const detailsA = await page.evaluate(() => {
            const msgs = document.querySelectorAll('.message');
            const results: any[] = [];
            msgs.forEach((m, i) => {
                const isGrouped = m.classList.contains('grouped');
                const hasAvatar = !!m.querySelector('.avatar');
                const hasDisplayName = !!m.querySelector('.display-name');
                const hasContent = !!m.querySelector('.content');
                const hasForwardLabel = !!m.querySelector('.forward-label');
                const textEl = m.querySelector('.text');
                const text = textEl ? textEl.textContent || '' : '';
                results.push({
                    idx: i, isGrouped, hasAvatar, hasDisplayName, hasContent,
                    hasForwardLabel,
                    textPreview: text.substring(0, 60),
                });
            });
            return results;
        });
        console.log('User A:\n' + JSON.stringify(detailsA, null, 2));

        expect(detailsA.length).toBeGreaterThanOrEqual(5);

        // Grouping expectations:
        //   Msg 0 (text)      — NOT grouped (first message, has own header)
        //   Msg 1 (forward)   — grouped with msg 0 (CSS hides display name/avatar)
        //   Msg 2 (sticker)   — grouped with msg 0
        //   Msg 3 (gif)       — grouped with msg 0
        //   Msg 4 (file)      — NOT grouped (breaks chain, has own header)
        expect(detailsA[0].isGrouped).toBe(false);
        expect(detailsA[1].isGrouped).toBe(true);
        expect(detailsA[2].isGrouped).toBe(true);
        expect(detailsA[3].isGrouped).toBe(true);
        expect(detailsA[4].isGrouped).toBe(false);

        // Msg 0 and Msg 4 have their own display-name header (non-grouped)
        // Grouped messages still have the element in DOM but it's hidden by CSS
        expect(detailsA[0].hasDisplayName).toBe(true);
        expect(detailsA[4].hasDisplayName).toBe(true);

        // All messages should have content and not be encrypted
        for (const msg of detailsA) {
            expect(msg.hasContent).toBe(true);
            expect(msg.textPreview).not.toContain('[encrypted]');
        }

        // Forward label is rendered (sender display name/PFP intentionally removed from forward labels)
        const fwdMsgA = detailsA.find((m: any) => m.hasForwardLabel);
        expect(fwdMsgA).toBeTruthy();

        // ── User B verifies messages ──
        // Navigate and wait for page's WS to connect and auth
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);
        // Use a direct evaluate that waits for the page WS, then calls selectDmChannel directly
        const convFound = await page2.evaluate(async ({ dmChannelId, user1id, user1name }: any) => {
            // Wait for page's WS
            for (let i = 0; i < 60; i++) {
                if ((window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 200));
            }
            // Wait a moment for dmConversations to populate
            await new Promise(r => setTimeout(r, 2000));
            if (typeof (window as any).selectDmChannel === 'function') {
                await (window as any).selectDmChannel(dmChannelId, user1id, user1name, null);
                // Wait for messages to load
                await new Promise(r => setTimeout(r, 4000));
                return 'selected';
            }
            return 'no_selectDmChannel';
        }, { dmChannelId, user1id: body1.user.id, user1name: user1 });
        console.log('User B DM result:', convFound);

        const detailsB = await page2.evaluate(() => {
            const msgs = document.querySelectorAll('.message');
            const results: any[] = [];
            msgs.forEach((m, i) => {
                const isGrouped = m.classList.contains('grouped');
                const hasAvatar = !!m.querySelector('.avatar');
                const hasDisplayName = !!m.querySelector('.display-name');
                const hasContent = !!m.querySelector('.content');
                const hasForwardLabel = !!m.querySelector('.forward-label');
                const textEl = m.querySelector('.text');
                const text = textEl ? textEl.textContent || '' : '';
                results.push({
                    idx: i, isGrouped, hasAvatar, hasDisplayName, hasContent,
                    hasForwardLabel,
                    textPreview: text.substring(0, 60),
                });
            });
            return results;
        });
        console.log('User B:\n' + JSON.stringify(detailsB, null, 2));

        expect(detailsB.length).toBeGreaterThanOrEqual(5);

        // Same grouping expectations for User B
        expect(detailsB[0].isGrouped).toBe(false);
        expect(detailsB[1].isGrouped).toBe(true);
        expect(detailsB[2].isGrouped).toBe(true);
        expect(detailsB[3].isGrouped).toBe(true);
        expect(detailsB[4].isGrouped).toBe(false);

        expect(detailsB[0].hasDisplayName).toBe(true);
        expect(detailsB[4].hasDisplayName).toBe(true);

        for (const msg of detailsB) {
            expect(msg.hasContent).toBe(true);
            expect(msg.textPreview).not.toContain('[encrypted]');
        }

        // Forward label on recipient side (sender display name/PFP intentionally removed)
        const fwdMsgB = detailsB.find((m: any) => m.hasForwardLabel);
        expect(fwdMsgB).toBeTruthy();

        await page2.close();
    });
});
