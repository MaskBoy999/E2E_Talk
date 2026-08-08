import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

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

async function createServer(page: any, name: string) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    return { serverId, token };
}

async function createChannel(page: any, serverId: string, token: string, name: string, channelType: string) {
    const encName = await page.evaluate(async (nm) => {
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        return E2ECrypto.aeadEncrypt(nm, new Uint8Array(k));
    }, name);
    const res = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: channelType },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).id;
}

test.describe('Message pinning (per-channel)', () => {

    test('server channel: pin shows badge + pins panel + jump-to-pin', async ({ browser }) => {
        const ts = Date.now();
        const page = await (await browser.newContext()).newPage();
        await registerUser(page, 'pinner_a_' + ts);
        const srv = await createServer(page, 'PIN_' + ts);
        await page.waitForTimeout(1000);
        const chId = await createChannel(page, srv.serverId, srv.token, 'general', 'text');

        // Re-select the server so the channel list re-renders from the API
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${chId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${chId}"]`);
        await page.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
        await page.waitForTimeout(800);

        // Send a message through the real composer (encrypted end-to-end)
        await page.fill('#message-input', 'pinned test message ' + ts);
        await page.press('#message-input', 'Enter');
        await page.waitForSelector('.message[data-message-id]', { timeout: 10000 });
        const renderedId = await page.evaluate(() => {
            const el = document.querySelector('.message[data-message-id]');
            return el ? el.getAttribute('data-message-id') : null;
        });
        expect(renderedId).toBeTruthy();

        // Hover the message to reveal actions, click pin
        await page.hover(`.message[data-message-id="${renderedId}"]`);
        await page.waitForSelector(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="pin"]`, { timeout: 5000 });
        await page.click(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="pin"]`);
        // Optimistic/echo: pin badge should appear (server echoes message_pinned)
        await page.waitForFunction((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"]');
            return el && (el.querySelector('.pin-badge') || el.getAttribute('data-pinned') === '1');
        }, renderedId, { timeout: 10000 });

        // REST: the pin list endpoint returns this message
        const pins = await (await page.request.get(`${BASE}/api/channels/${chId}/pins`, {
            headers: { Authorization: `Bearer ${srv.token}` },
        })).json();
        expect(Array.isArray(pins)).toBe(true);
        expect(pins.some((p: any) => p.id === renderedId)).toBe(true);
        expect(pins[0].pinned).toBe(true);

        // Message list flag also reflects pinned
        const msgs = await (await page.request.get(`${BASE}/api/channels/${chId}/messages`, {
            headers: { Authorization: `Bearer ${srv.token}` },
        })).json();
        const found = msgs.find((m: any) => m.id === renderedId);
        expect(found && found.pinned).toBe(true);

        // Pins panel opens and lists the message with a jump button
        await page.click('#pins-btn');
        await page.waitForSelector('#pins-modal[style*="flex"], #pins-modal:not([style*="display: none"])', { timeout: 5000 }).catch(() => {});
        await page.waitForSelector('.pins-item', { timeout: 10000 });
        const panelText = await page.evaluate(() => document.getElementById('pins-list')?.textContent || '');
        expect(panelText).toContain('pinned test message');
        expect(await page.locator('.pins-item-jump').count()).toBeGreaterThan(0);

        // Unpin through the panel-independent path: unpin button on the message
        await page.click('#close-pins-modal').catch(() => {});
        await page.waitForTimeout(300);
        await page.hover(`.message[data-message-id="${renderedId}"]`);
        await page.waitForSelector(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="unpin"]`, { timeout: 5000 });
        await page.click(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="unpin"]`);
        await page.waitForFunction((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"]');
            return el && !el.querySelector('.pin-badge') && el.getAttribute('data-pinned') !== '1';
        }, renderedId, { timeout: 10000 });

        // REST confirms unpin
        const pins2 = await (await page.request.get(`${BASE}/api/channels/${chId}/pins`, {
            headers: { Authorization: `Bearer ${srv.token}` },
        })).json();
        expect(pins2.some((p: any) => p.id === renderedId)).toBe(false);

        await page.context().close();
    });

    test('server channel: non-owner sees NO pin button and the server rejects their pin', async ({ browser }) => {
        const ts = Date.now();
        const ctxOwner = await browser.newContext();
        const ctxMember = await browser.newContext();
        const page = await ctxOwner.newPage();
        const page2 = await ctxMember.newPage();
        const ownerBody = await registerUser(page, 'pinowner_' + ts);
        const memberBody = await registerUser(page2, 'pinmember_' + ts);

        // Owner creates server + channel via UI so keys are set up correctly
        await page.waitForTimeout(1000);
        const srv = await createServer(page, 'PINRO_' + ts);
        await page.waitForTimeout(1000);
        const chId = await createChannel(page, srv.serverId, srv.token, 'general', 'text');
        const inviteCode = await page.evaluate(() => localStorage.getItem('e2e_invite_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        expect(inviteCode).toBeTruthy();

        // Member joins via the invite code
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${memberBody.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Owner sends the server key to the member so the member can decrypt messages.
        // Simplest reliable path: the owner broadcasts a server key sync by sending a
        // message through the UI (message_send embeds the snapshot + key share happens
        // on member presence). Instead, push the key directly via the keys endpoint.
        const srvKey = await page.evaluate((sid) => {
            return E2ECrypto.arrayBufferToBase64(E2ECrypto.getServerKey(sid));
        }, srv.serverId);
        const memberId = memberBody.user.id;
        const memberPub = await (await page.request.get(`${BASE}/api/identity/${memberId}`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        })).json();
        const wrappedKey = await page.evaluate(async ({ pub, keyB64 }) => {
            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pub));
            const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            return E2ECrypto.envelopeEncryptRaw(keyBytes, pubBytes);
        }, { pub: memberPub.identity_public_key, keyB64: srvKey });
        await page.request.post(`${BASE}/api/servers/${srv.serverId}/keys`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: memberId,
                encrypted_key: wrappedKey.ciphertext,
                sender_public_key: wrappedKey.ephemeralPublicKey,
                nonce: wrappedKey.nonce,
            }),
        });

        // Member loads the server key into their local crypto store
        await page2.evaluate(async ({ sid, keyB64 }) => {
            const keyBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
            E2ECrypto.saveServerKey(sid, keyBytes);
        }, { sid: srv.serverId, keyB64: srvKey });

        // Owner sends a message through the UI (they're the owner)
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForSelector(`.channel-item[data-id="${chId}"]`, { timeout: 10000 });
        await page.click(`.channel-item[data-id="${chId}"]`);
        await page.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.fill('#message-input', 'owner pinned message');
        await page.press('#message-input', 'Enter');
        await page.waitForSelector('.message[data-message-id]', { timeout: 10000 });
        const ownerMsgId = await page.evaluate(() => document.querySelector('.message[data-message-id]')?.getAttribute('data-message-id') || null);
        expect(ownerMsgId).toBeTruthy();

        // Member opens the channel and sends their own message
        await page2.evaluate(() => {
            // refresh servers list so the member sees the joined server
            loadServers();
        });
        await page2.waitForSelector(`.server-icon[data-id="${srv.serverId}"]`, { timeout: 15000 });
        await page2.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page2.waitForSelector(`.channel-item[data-id="${chId}"]`, { timeout: 10000 });
        await page2.click(`.channel-item[data-id="${chId}"]`);
        await page2.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
        await page2.waitForTimeout(500);
        await page2.fill('#message-input', 'member message');
        await page2.press('#message-input', 'Enter');
        await page2.waitForSelector('.message[data-message-id]', { timeout: 10000 });
        const memberMsgId = await page2.evaluate(() => {
            const els = document.querySelectorAll('.message[data-message-id]');
            return els.length ? els[els.length - 1].getAttribute('data-message-id') : null;
        });
        expect(memberMsgId).toBeTruthy();

        // Member: NO pin button on any message (they are not the owner)
        const memberHasPinBtn = await page2.evaluate(() => !!document.querySelector('.msg-action-btn[data-action="pin"], .msg-action-btn[data-action="unpin"]'));
        expect(memberHasPinBtn).toBe(false);

        // Member tries to pin via raw WS — server must reject (owner-only)
        const memberPinAccepted = await page2.evaluate((mid) => {
            return new Promise((resolve) => {
                if (!ws || ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
                // Observe whether a message_pinned event comes back
                let got = false;
                const handler = (ev) => {
                    const d = JSON.parse(ev.data);
                    if (d.type === 'message_pinned' && d.message_id === mid) { got = true; }
                };
                ws.addEventListener('message', handler);
                ws.send(JSON.stringify({ type: 'message_pin', channel_id: (window as any).currentChannelId, message_id: mid }));
                setTimeout(() => {
                    ws.removeEventListener('message', handler);
                    resolve(got);
                }, 1500);
            });
        }, memberMsgId);
        expect(memberPinAccepted).toBe(false);

        // Owner sees their pin button and can pin (sanity check)
        await page.hover(`.message[data-message-id="${ownerMsgId}"]`);
        await page.waitForSelector(`.message[data-message-id="${ownerMsgId}"] .msg-action-btn[data-action="pin"]`, { timeout: 5000 });
        await page.click(`.message[data-message-id="${ownerMsgId}"] .msg-action-btn[data-action="pin"]`);
        await page.waitForFunction((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"]');
            return el && (el.querySelector('.pin-badge') || el.getAttribute('data-pinned') === '1');
        }, ownerMsgId, { timeout: 10000 });
        // The owner's pin button now shows the pinned indicator (gold class)
        const ownerBtnPinned = await page.evaluate((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"] .msg-action-btn[data-action="unpin"]');
            return el ? el.classList.contains('pinned') : false;
        }, ownerMsgId);
        expect(ownerBtnPinned).toBe(true);

        await ctxOwner.close();
        await ctxMember.close();
    });

    test('DM: pin/unpin + pins panel shows the encrypted content decrypted locally', async ({ browser }) => {
        const ts = Date.now();
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const body1 = await registerUser(page, 'pinner_b_' + ts);
        const body2 = await registerUser(page2, 'pinner_c_' + ts);

        // Friends + DM
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();

        // Open the DM on both sides
        await page.click('#dm-strip-btn').catch(() => {});
        await page2.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        await page2.waitForTimeout(800);
        await page.locator('[data-dm-id]').first().click().catch(() => {});
        await page2.locator('[data-dm-id]').first().click().catch(() => {});
        await page.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
        await page2.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });

        // A sends a DM
        await page.fill('#message-input', 'dm pin target');
        await page.press('#message-input', 'Enter');
        await page.waitForSelector('.message[data-message-id]', { timeout: 10000 });
        const renderedId = await page.evaluate(() => document.querySelector('.message[data-message-id]')?.getAttribute('data-message-id') || null);
        expect(renderedId).toBeTruthy();

        // B sees the message arrive
        await page2.waitForSelector(`.message[data-message-id="${renderedId}"]`, { timeout: 10000 });

        // B pins it (DM members both can pin)
        await page2.hover(`.message[data-message-id="${renderedId}"]`);
        await page2.waitForSelector(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="pin"]`, { timeout: 5000 });
        await page2.click(`.message[data-message-id="${renderedId}"] .msg-action-btn[data-action="pin"]`);
        await page2.waitForFunction((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"]');
            return el && (el.querySelector('.pin-badge') || el.getAttribute('data-pinned') === '1');
        }, renderedId, { timeout: 10000 });
        // B's pin button now shows the pinned indicator (gold class)
        const bBtnPinned = await page2.evaluate((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"] .msg-action-btn[data-action="unpin"]');
            return el ? el.classList.contains('pinned') : false;
        }, renderedId);
        expect(bBtnPinned).toBe(true);

        // A sees the pin event too (WS broadcast to both DM members)
        await page.waitForFunction((id) => {
            const el = document.querySelector('.message[data-message-id="' + id + '"]');
            return el && (el.querySelector('.pin-badge') || el.getAttribute('data-pinned') === '1');
        }, renderedId, { timeout: 10000 });

        // A opens the pins panel — content is decrypted locally and shows the text
        await page.click('#pins-btn');
        await page.waitForSelector('.pins-item', { timeout: 10000 });
        const panelText = await page.evaluate(() => document.getElementById('pins-list')?.textContent || '');
        expect(panelText).toContain('dm pin target');

        // REST: pin exists for the DM channel
        const dmPins = await (await page.request.get(`${BASE}/api/dm/${dm.id}/pins`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dmPins.some((p: any) => p.id === renderedId)).toBe(true);

        await ctx1.close();
        await ctx2.close();
    });
});
