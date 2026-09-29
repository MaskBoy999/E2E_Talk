// What text the app lets you select, and the one control that replaces a
// right-click.
//
// Two user-visible rules, both of which a reader notices within a minute:
//
//  1. Dragging across the app used to highlight whatever it crossed — a
//     channel name, a server row, a display name, an avatar's initial — and
//     the browser then threw its own copy/select menu over the same gestures
//     that reorder rows and open menus. So the app is non-selectable by
//     default, with three exceptions: form fields, the codes that exist to be
//     copied (invite code, friend code, identity key — they keep
//     `user-select: all`, so one click takes the whole value), and **message
//     text on a device with a fine pointer**. That last one is the deliberate
//     asymmetry: reading a conversation means quoting a line of it, while a
//     phone has no text cursor to place and a press on a message must stay a
//     tap. A touch-screen laptop has a mouse as its primary pointer, so it
//     selects even though it also has a touchscreen.
//
//  2. Messages carry a ⋯ button that opens exactly the menu the right-click
//     opens, sitting alongside the pin/react/edit/delete shortcuts in one row.
//     That row is the SAME on desktop and touch; the Display → Message Actions
//     setting is what a phone changes (there is no hover there), not a
//     different row.
//
// Selection is checked by *doing it*: a real mouse drag across the text, then
// reading `window.getSelection()`. `getComputedStyle(...).userSelect` cannot
// answer this question — `user-select` is not inherited, so an element under a
// `user-select: none` ancestor still reports `auto`.
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

/** A server with one channel, plus this user's key for it (needed to send). */
async function createServerAndKey(page: Page, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const keys = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Selection Test Server', key),
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

/**
 * Drag across an element's text with the real mouse, then read the selection.
 *
 * `force` is not used and the drag is deliberately slow (steps) so Chromium
 * treats it as a selection gesture rather than a click.
 */
async function dragSelect(page: Page, selector: string): Promise<string> {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`no box for ${selector}`);
    const y = box.y + box.height / 2;
    const x1 = box.x + 2;
    const x2 = box.x + Math.max(10, box.width - 2);
    await page.mouse.move(x1, y);
    await page.mouse.down();
    await page.mouse.move(x2, y, { steps: 12 });
    await page.mouse.up();
    const selected = await page.evaluate(() => (window.getSelection() || '').toString());
    // Clear it so the next drag starts from nothing.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    return selected.trim();
}

async function menuLabels(page: Page): Promise<string[]> {
    await page.waitForSelector('.channel-context-menu', { timeout: 10000 });
    return (await page.locator('.channel-context-menu .context-menu-item').allTextContents()).map((s) => s.trim());
}

/**
 * Close the menu by taking it out of the DOM.
 *
 * Deliberately not a click somewhere "empty": the app is full of controls, and
 * a stray click at a fixed coordinate can switch a channel (which is how the
 * first draft of this spec lost its own message between assertions).
 */
async function dismissMenu(page: Page) {
    await page.evaluate(() => document.querySelectorAll('.channel-context-menu').forEach((m) => m.remove()));
}

/** The ⋯ button lives in a row that is hover-only on a pointer device. */
async function openMenuFromButton(page: Page) {
    const msg = page.locator('.message').last();
    await msg.hover();
    await msg.locator('.msg-action-btn[data-action="more"]').click();
}

test.describe('desktop: message text is selectable, everything else is not', () => {
    test('a drag selects a message line but not the chrome around it', async ({ page }) => {
        test.setTimeout(180000);
        const body = await registerUser(page, 'sel_' + Date.now());
        await createServerAndKey(page, body.token, body.user.id);
        await openChannelAndSend(page, 'selectable message body text');

        // This profile really is a pointer device, so the exception applies…
        expect(await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true);
        // …and the two sides of the rule are declared on the elements themselves
        // (`user-select` is NOT inherited, so a descendant of a non-selectable
        // ancestor still reports `auto` — which is why the enforcement below is
        // checked by actually dragging).
        const declared = await page.evaluate(() => {
            const read = (sel: string) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                return el ? getComputedStyle(el).userSelect : 'missing';
            };
            return {
                messageText: read('.message .text'),
                channelName: read('.channel-item'),
                serverRow: read('.server-icon:not(.add-server)'),
                messageHeader: read('.message .header'),
            };
        });
        expect(declared.messageText).toBe('text');
        expect(declared.channelName).toBe('none');
        expect(declared.serverRow).toBe('none');
        expect(declared.messageHeader).toBe('none');

        // 1. Message text: a drag produces a selection.
        const messageText = await dragSelect(page, '.message .text');
        expect(messageText, 'message text must be selectable on a desktop').toContain('selectable message body text');

        // 2. The author's display name, the channel name and the server icon
        //    letter are not: dragging them selects nothing.
        expect(await dragSelect(page, '.message .display-name'), 'a display name must not be selectable').toBe('');
        expect(await dragSelect(page, '.channel-item'), 'a channel name must not be selectable').toBe('');
        expect(await dragSelect(page, '.server-icon:not(.add-server)'), 'a server row must not be selectable').toBe('');

        // 3. The three things that opt back in explicitly.
        //    Form fields…
        expect(await page.evaluate(() => getComputedStyle(document.getElementById('message-input') as HTMLElement).userSelect))
            .toBe('text');
        //    …and the codes, which keep `user-select: all` so one click takes
        //    the whole value (the invite code is inside .identity-key-box).
        expect(await page.evaluate(() => getComputedStyle(document.getElementById('invite-code-display') as HTMLElement).userSelect))
            .toBe('all');
        expect(await page.evaluate(() => {
            const el = document.getElementById('invite-code-display') as HTMLElement;
            return el.closest('.identity-key-box') !== null;
        })).toBe(true);
    });

    test('the ⋯ button opens the same menu as the right-click', async ({ page }) => {
        test.setTimeout(180000);
        const body = await registerUser(page, 'selm_' + Date.now());
        await createServerAndKey(page, body.token, body.user.id);
        await openChannelAndSend(page, 'message for the action menu');

        // Every rendered message carries the button.
        expect(await page.locator('.message .msg-action-btn[data-action="more"]').count()).toBeGreaterThan(0);

        // The right-click menu, as the reference.
        await page.locator('.message .text').last().click({ button: 'right' });
        const fromRightClick = await menuLabels(page);
        expect(fromRightClick.length).toBeGreaterThan(3);
        expect(fromRightClick).toContain('Copy Text');
        await dismissMenu(page);

        // The same menu, from the button — no right button involved.
        await openMenuFromButton(page);
        const fromButton = await menuLabels(page);

        expect(fromButton, 'the ⋯ button must open exactly the right-click menu').toEqual(fromRightClick);
        await dismissMenu(page);
        expect(await page.locator('.channel-context-menu').count()).toBe(0);
    });
});

test.describe('touch: text stays unselectable, but the action row matches desktop', () => {
    // A phone profile: coarse pointer, no hover — the same media query the
    // desktop exception is gated on.
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test('a drag does not select message text, and the full action row can be kept up', async ({ page }) => {
        test.setTimeout(180000);
        const body = await registerUser(page, 'selt_' + Date.now());
        await createServerAndKey(page, body.token, body.user.id);
        await openChannelAndSend(page, 'unselectable on a phone');

        expect(await page.evaluate(() => window.matchMedia('(pointer: fine)').matches)).toBe(false);

        // Default 'hover' mode: a phone has no hover, so the row is hidden at
        // rest — and it is the WHOLE row, not ⋯ on its own.
        await expect(page.locator('.message .msg-action-btn[data-action="more"]').last()).toBeHidden();

        // Switch the Display setting to 'Always on' — the touch-friendly mode —
        // the way the select itself does.
        await page.evaluate(() => {
            const sel = document.getElementById('show-msg-actions') as HTMLSelectElement;
            sel.value = 'always';
            sel.dispatchEvent(new Event('change'));
        });
        // ⋯ sits ALONGSIDE react/edit/delete, exactly like desktop.
        await expect(page.locator('.message .msg-action-btn[data-action="more"]').last()).toBeVisible();
        await expect(page.locator('.message .msg-action-btn[data-action="react"]').last()).toBeVisible();

        // …and ⋯ still opens the real menu, Edit included (we own the message).
        await page.locator('.message .msg-action-btn[data-action="more"]').last().click();
        const labels = await menuLabels(page);
        expect(labels).toContain('Copy Text');
        expect(labels).toContain('Edit');
        await dismissMenu(page);

        // Dragging the message does not highlight it here (the desktop
        // exception is gated on a fine pointer, which this profile is not).
        const selected = await dragSelect(page, '.message .text');
        expect(selected, 'message text must stay unselectable on touch').toBe('');
    });
});
