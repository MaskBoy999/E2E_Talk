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

async function createServer(page: any, ts: number) {
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'NR_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id'));
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const encName = await page.evaluate(async (name) => {
        const k = E2ECrypto.base64ToArrayBuffer(localStorage.getItem('e2e_server_' + document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')));
        return E2ECrypto.aeadEncrypt(name, new Uint8Array(k));
    }, 'General');
    const res = await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { encrypted_name: encName.ciphertext, name_nonce: encName.nonce, channel_type: 'text' },
    });
    expect(res.ok()).toBeTruthy();
    return { serverId, channelId: (await res.json()).id, token };
}

async function joinChannel(page: any, serverId: string, channelId: string) {
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 10000 });
    await page.click(`.channel-item[data-id="${channelId}"]`);
    await page.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
    await page.waitForTimeout(1200);
}

async function sendText(page: any, text: string) {
    await page.fill('#message-input', text);
    await page.click('#send-btn');
    await page.waitForFunction((t) => {
        const list = document.getElementById('message-list')!;
        return Array.from(list.querySelectorAll('.text')).some((el) => (el.textContent || '').includes(t));
    }, text, { timeout: 10000 });
}

test.describe('reply notification redirect + load scroll', () => {
    test('normal channel load scrolls to bottom; reply redirect lands on the REPLY with highlight (no bottom flash)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const u1 = await registerUser(page, 'nr1_' + ts);
        const srv = await createServer(page, ts);

        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const u2 = await registerUser(page2, 'nr2_' + ts);

        const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
        await page.request.post(`${BASE}/api/servers/${srv.serverId}/invite`, {
            headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
            data: { invite_code: code },
        });
        await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${u2.token}`, 'Content-Type': 'application/json' },
            data: { code },
        });

        await joinChannel(page, srv.serverId, srv.channelId);
        await page2.reload();
        await page2.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await joinChannel(page2, srv.serverId, srv.channelId);

        // Fill the page so the list is scrollable
        for (let i = 0; i < 60; i++) {
            await sendText(page, 'bulk-' + i + '-' + ts);
        }

        // --- 1. Normal channel (re)load scrolls to the bottom ---
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForTimeout(800);
        await page.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page.waitForTimeout(1500);
        const scrollState = await page.evaluate(() => {
            const list = document.getElementById('message-list')!;
            return {
                atBottom: list.scrollTop + list.clientHeight >= list.scrollHeight - 8,
            };
        });
        expect(scrollState.atBottom).toBe(true);

        // --- 2. Reply notification redirect lands on the REPLY ---
        // A sends the original, then A goes home so B's reply arrives as a notification
        await page.click(`.channel-item[data-id="${srv.channelId}"]`);
        await page.waitForTimeout(800);
        await sendText(page, 'ORIGINAL-msg-' + ts);
        await page.click(`.server-icon[data-id="${srv.serverId}"]`);
        await page.waitForTimeout(800);

        // B replies via the UI (real reply payload)
        await page2.waitForFunction((t) => {
            const list = document.getElementById('message-list')!;
            return Array.from(list.querySelectorAll('.text')).some((el) => (el.textContent || '').includes(t));
        }, 'ORIGINAL-msg-' + ts, { timeout: 10000 });
        const origMsg = page2.locator('.message', { hasText: 'ORIGINAL-msg-' + ts }).first();
        await origMsg.hover();
        await page2.waitForTimeout(400);
        await origMsg.locator('.msg-action-btn[data-action="reply"]').first().click();
        await page2.fill('#message-input', 'REPLY-msg-' + ts);
        await page2.click('#send-btn');
        await page2.waitForFunction((t) => {
            const list = document.getElementById('message-list')!;
            return Array.from(list.querySelectorAll('.text')).some((el) => (el.textContent || '').includes(t));
        }, 'REPLY-msg-' + ts, { timeout: 10000 });

        // A opens the mentions inbox and clicks the reply notification
        await page.waitForTimeout(1500);
        await page.click('#mentions-strip-btn').catch(() => {});
        await page.waitForSelector('#mentions-panel:visible', { timeout: 10000 });
        await page.waitForTimeout(800);
        const notifMessageId = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.mention-inbox-item'));
            return items.length ? (items[0] as HTMLElement).dataset.messageId : null;
        });
        expect(notifMessageId).toBeTruthy();

        await page.locator('.mention-inbox-item').first().click();
        // Check the highlight quickly (it now lasts ~3.8s)
        await page.waitForTimeout(900);
        const highlighted = await page.evaluate((mid) => {
            const list = document.getElementById('message-list')!;
            const hl = list.querySelector('.flash-highlight');
            const hlText = hl ? (hl.querySelector('.text')?.textContent || '') : '';
            const hlId = hl ? hl.getAttribute('data-message-id') : '';
            const replyEl = list.querySelector('.message[data-message-id="' + mid + '"]');
            const rr = replyEl ? replyEl.getBoundingClientRect() : null;
            const lr = list.getBoundingClientRect();
            return {
                hlText,
                hlId,
                hlIsReply: !!hl && hlId === mid,
                replyInViewport: rr ? (rr.top < lr.bottom && rr.bottom > lr.top) : false,
            };
        }, notifMessageId!);
        expect(highlighted.hlIsReply).toBe(true); // the flash is ON the reply
        expect(highlighted.hlText).toContain('REPLY-msg-');
        expect(highlighted.replyInViewport).toBe(true);
    });
});
