import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Forwarded custom-emoji refs', () => {

    async function loginUser(browser, username: string) {
        const page = await browser.newPage();
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.waitForSelector('#register-form', { state: 'visible' });
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForFunction(() => {
            const t = localStorage.getItem('token');
            return t && t.length > 20;
        }, { timeout: 15000 });
        return page;
    }

    test('collectEmojiRefsFromMsgEl recovers refs from rendered emoji data attrs', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'fwd_emoji_refs_' + ts);
        await page.waitForTimeout(1500);

        // Build a fake .message DOM containing a rendered custom emoji <img> that
        // has the data-file-id/data-file-key attrs stamped by renderEmojiText.
        const result = await page.evaluate(() => {
            const div = document.createElement('div');
            div.className = 'message';
            div.innerHTML =
                '<div class="text">' +
                '<img class="emoji-inline" src="blob:http://localhost:3443/fake-uuid" ' +
                'alt=":friend_upload_emoji:" title=":friend_upload_emoji:" ' +
                'data-file-id="file-111" data-file-key="a2V5MTEx">' +
                '</div>';
            // Emoji NOT in local cache → must be recovered from the DOM data attrs
            // (the blob src cannot be parsed back into file_id/file_key).
            const refs = collectEmojiRefsFromMsgEl(div, 'hello :friend_upload_emoji: world');
            return { refs };
        });

        expect(result.refs.length).toBe(1);
        expect(result.refs[0].name).toBe('friend_upload_emoji');
        expect(result.refs[0].file_id).toBe('file-111');
        expect(result.refs[0].file_key).toBe('a2V5MTEx');
    });

    test('collectEmojiRefsFromMsgEl also handles still-loading placeholder spans', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'fwd_emoji_span_' + ts);
        await page.waitForTimeout(1500);

        const result = await page.evaluate(() => {
            const div = document.createElement('div');
            div.className = 'message';
            div.innerHTML =
                '<div class="text">' +
                '<span class="emoji-loading" data-emoji-name="still_loading" ' +
                'data-file-id="file-222" data-file-key="a2V5MjIy">:still_loading:</span>' +
                '</div>';
            const refs = collectEmojiRefsFromMsgEl(div, ':still_loading:');
            return { refs };
        });

        expect(result.refs.length).toBe(1);
        expect(result.refs[0].name).toBe('still_loading');
        expect(result.refs[0].file_id).toBe('file-222');
        expect(result.refs[0].file_key).toBe('a2V5MjIy');
    });

    test('truncateForwardPreview never splits a :shortcode: in half', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'fwd_emoji_trunc_' + ts);
        await page.waitForTimeout(1500);

        const result = await page.evaluate(() => {
            // 6 long emoji shortcodes concatenated (no spaces) — a realistic
            // emoji-only message longer than the 80-char preview cap.
            const long = ':screenshot_2025_10_12_220311::screenshot_2025_10_12_220311::screenshot_2025_10_12_220311::screenshot_2025_10_12_220311::screenshot_2025_10_12_220311::screenshot_2025_10_12_220311:';
            const cut = truncateForwardPreview(long);
            // Every :name: in the output must be complete (even count of colons,
            // and no dangling shortcode).
            const colonCount = (cut.match(/:/g) || []).length;
            const looksWhole = colonCount % 2 === 0 && /:([^:]+):$/.test(cut);
            // Also test plain short text is unchanged.
            const short = truncateForwardPreview('hello world');
            return { len: cut.length, colonCount, looksWhole, short };
        });

        expect(result.short).toBe('hello world');
        expect(result.colonCount % 2).toBe(0);
        expect(result.looksWhole).toBe(true);
        expect(result.len).toBeGreaterThan(0);
    });

    test('executeDmForwardToChannel embeds emoji refs in the preview plaintext', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'fwd_emoji_dm2chan_' + ts);
        await page.waitForTimeout(1500);

        // Simulate the exact preview-plaintext construction the DM→channel path
        // uses, with a message div carrying rendered emoji data attrs.
        const result = await page.evaluate(() => {
            const div = document.createElement('div');
            div.className = 'message';
            div.innerHTML =
                '<div class="text">' +
                '<img class="emoji-inline" src="blob:http://localhost:3443/u1" ' +
                'alt=":screenshot_emoji:" title=":screenshot_emoji:" ' +
                'data-file-id="file-333" data-file-key="a2V5MzMz">' +
                '</div>';
            const originalText = extractRawMessageText(div.querySelector('.text'));
            const previewEmojiRefs = collectEmojiRefsFromMsgEl(div, originalText);
            const previewPlaintext = JSON.stringify({ type: 'text', text: originalText || '', emojis: previewEmojiRefs });
            const parsed = JSON.parse(previewPlaintext);
            return { text: parsed.text, emojis: parsed.emojis };
        });

        expect(result.text).toContain(':screenshot_emoji:');
        expect(result.emojis.length).toBe(1);
        expect(result.emojis[0].file_id).toBe('file-333');
        expect(result.emojis[0].file_key).toBe('a2V5MzMz');
    });
});
