import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test('probe: DM edit propagation', async ({ page, context }) => {
    const ts = Date.now();
    const user1 = 'pda' + ts;
    const user2 = 'pdb' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    const body2 = await registerUser(page2, user2);
    const body1 = await registerUser(page, user1);

    // Instrument page1 BEFORE the edit happens
    await page.evaluate(() => {
        const log: any[] = [];
        (window as any).__editLog = log;
        const orig: any = (window as any).handleEditedMessage;
        (window as any).handleEditedMessage = async function (...args: any[]) {
            try {
                const msg = args[0];
                log.push('called mode=' + args[1] + ' msgId=' + (msg && msg.id) + ' hasContent=' + !!(msg && msg.encrypted_content) + ' sender_uid=' + (msg && msg.sender_user_id) + ' sender_id=' + (msg && msg.sender_id));
            } catch (e) { log.push('wrapper-err ' + e.message); }
            return orig.apply(this, args);
        };
        // Log ALL incoming WS message types on page1
        const origOnMsgDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
        const hook = function (this: any, ev: any) {
            try {
                const d = JSON.parse(ev.data);
                if (d && d.type) log.push('WS-RECV ' + d.type);
            } catch (_) {}
            const handler = (this as any).__origOnMsg;
            if (handler) handler.call(this, ev);
        };
        Object.defineProperty(WebSocket.prototype, 'onmessage', {
            get() { return this.__origOnMsg; },
            set(v) { this.__origOnMsg = v; },
            configurable: true,
        });
        // Patch any EXISTING socket's onmessage too (the app sets it via addEventListener usually)
        if (typeof ws !== 'undefined' && ws) {
            const orig = ws.onmessage;
            ws.onmessage = function (ev: any) {
                try {
                    const d = JSON.parse(ev.data);
                    if (d && d.type) log.push('WS-RECV ' + d.type);
                } catch (_) {}
                if (orig) return orig.call(this, ev);
            };
        }
    });

    // Become friends
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();

    const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dmId = convs[0].dm_channel_id;

    // user1 sends DM via WS (other_user_id from the API response, not in-page state)
    const otherUserId = convs[0].other_user_id;
    for (let i = 0; i < 20; i++) {
        const open = await page.evaluate(() => typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN);
        if (open) break;
        await page.waitForTimeout(300);
    }
    // Instrument onmessage on page1's live socket
    await page.evaluate(() => {
        const log = (window as any).__editLog;
        const orig = ws.onmessage || ws['__omsg'];
        const wrapper = function (ev: any) {
            try {
                const d = JSON.parse(ev.data);
                if (d && d.type) log.push('WS-RECV ' + d.type);
            } catch (_) {}
            const h = (ws as any).__origOnMsg;
            if (h) return h.call(this, ev);
        };
        (ws as any).__origOnMsg = orig;
        ws.onmessage = wrapper;
    });
    const sent = await page.evaluate(async ({ dmId, otherUserId }: any) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm('Hello from Alice!', dmId, kp.privateKey, otherPub);
        ws.send(JSON.stringify({
            type: 'dm_send',
            dm_channel_id: dmId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return 'sent';
    }, { dmId, otherUserId });
    expect(sent).toBe('sent');
    await page.waitForTimeout(1500);

    // user2 opens DM and sees it
    await page2.click('#dm-strip-btn');
    await page2.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page2.locator('.dm-item').count();
        if (count > 0) { await page2.locator('.dm-item').first().click().catch(() => {}); break; }
        await page2.waitForTimeout(300);
    }
    await page2.waitForTimeout(1500);

    // user2 edits
    const body1Id = body1.user.id;
    const user1PubRes = await page.request.get(`${BASE}/api/identity/${body1Id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    });
    const user1PubData = await user1PubRes.json();
    const user1PubKeyB64 = user1PubData.identity_public_key;

    const editSent = await page2.evaluate(async ({ dmId, user1PubKeyB64 }: any) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        const msgEl = document.querySelector('[data-message-id]');
        if (!msgEl) return 'no message element';
        const msgId = msgEl.getAttribute('data-message-id');
        const user1PubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user1PubKeyB64));
        const payload = { type: 'text', text: 'EDITED: This DM was changed!' };
        const enc = E2ECrypto.encryptDm(JSON.stringify(payload), dmId, kp.privateKey, user1PubKey);
        ws.send(JSON.stringify({
            type: 'dm_edit',
            message_id: msgId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        }));
        return 'edit sent: ' + msgId;
    }, { dmId, user1PubKeyB64 });
    console.log('EDIT-SENT:', editSent);
    expect(editSent).toContain('edit sent');

    await page.waitForTimeout(4000);

    const editLog = await page.evaluate(() => (window as any).__editLog || []);
    console.log('PAGE1-EDITLOG:', JSON.stringify(editLog));

    const state1 = await page.evaluate(() => {
        const label = document.querySelector('.edited-label');
        const textEl = document.querySelector('.text');
        return {
            hasLabel: !!label,
            labelText: label ? label.textContent : null,
            text: textEl ? textEl.textContent : null,
            msgCount: document.querySelectorAll('[data-message-id]').length,
        };
    });
    console.log('PAGE1-STATE:', JSON.stringify(state1));

    await page2.close();
    await ctx2.close();
});

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(400);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    const body = await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
    return body;
}
