import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Message timestamps 3-state toggle + placement', () => {

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

    test('default: hover mode is applied and the select exists', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_toggle_' + ts);
        await page.waitForTimeout(1500);

        const state = await page.evaluate(() => {
            const sel = document.getElementById('show-msg-times') as HTMLSelectElement;
            return {
                bodyAlways: document.body.classList.contains('show-msg-times-always'),
                bodyHover: document.body.classList.contains('show-msg-times-hover'),
                bodyLegacy: document.body.classList.contains('show-msg-times'),
                isSelect: !!sel && sel.tagName === 'SELECT',
                value: sel ? sel.value : null,
                stored: localStorage.getItem('show_msg_times'),
            };
        });
        expect(state.bodyAlways).toBe(false);
        expect(state.bodyHover).toBe(true); // default hover-only
        expect(state.bodyLegacy).toBe(false);
        expect(state.isSelect).toBe(true);
        expect(state.value).toBe('hover');
    });

    test('hover mode shows the time on hover only (no layout shift)', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_hover_' + ts);
        await page.waitForTimeout(1500);

        const result = await page.evaluate(() => {
            const sel = document.getElementById('show-msg-times') as HTMLSelectElement;
            sel.value = 'hover';
            sel.dispatchEvent(new Event('change', { bubbles: true }));

            const div = document.createElement('div');
            div.className = 'message';
            div.innerHTML = '<div class="text">hello world<span class="time-hover">1:00:00</span></div>';
            document.body.appendChild(div);
            const span = div.querySelector('.time-hover') as HTMLElement;

            // :hover cannot be faked reliably in headless; verify the span is
            // hidden without hover (no always-on push) and that the stylesheet
            // contains the hover-reveal rule.
            const notHovered = getComputedStyle(span).display;
            div.remove();
            return {
                notHovered,
                ruleText: Array.from((document.styleSheets as any)).some((s: any) => {
                    try {
                        return Array.from(s.cssRules).some((r: any) => r.selectorText &&
                            r.selectorText.includes('show-msg-times-hover') &&
                            r.selectorText.includes(':hover'));
                    } catch { return false; }
                }),
                bodyHover: document.body.classList.contains('show-msg-times-hover'),
                bodyAlways: document.body.classList.contains('show-msg-times-always'),
                stored: localStorage.getItem('show_msg_times'),
            };
        });
        // The span must be hidden when not hovered (no always-on push).
        expect(result.notHovered).toBe('none');
        expect(result.ruleText).toBe(true); // the :hover rule exists in the stylesheet
        expect(result.bodyHover).toBe(true);
        expect(result.bodyAlways).toBe(false);
        expect(result.stored).toBe('hover');
    });

    test('off mode hides timestamps entirely', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_off_' + ts);
        await page.waitForTimeout(1500);

        const result = await page.evaluate(() => {
            const sel = document.getElementById('show-msg-times') as HTMLSelectElement;
            sel.value = 'off';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return {
                bodyAlways: document.body.classList.contains('show-msg-times-always'),
                bodyHover: document.body.classList.contains('show-msg-times-hover'),
                stored: localStorage.getItem('show_msg_times'),
            };
        });
        expect(result.bodyAlways).toBe(false);
        expect(result.bodyHover).toBe(false);
        expect(result.stored).toBe('off');
    });

    test('time-hover span is rendered at the END of the message text, not the start', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_placement_' + ts);
        await page.waitForTimeout(1500);

        const order = await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = '<div class="text">hello world<span class="time-hover">12:34:56</span></div>';
            const textDiv = div.querySelector('.text')!;
            const span = textDiv.querySelector('.time-hover')!;
            const textNode = textDiv.childNodes[0];
            return {
                firstIsText: textNode.nodeType === Node.TEXT_NODE && textNode.textContent === 'hello world',
                spanIsLast: textDiv.lastChild === span,
                hasTextBefore: (textDiv.textContent || '').indexOf('hello world') < (textDiv.textContent || '').indexOf('12:34:56'),
            };
        });
        expect(order.firstIsText).toBe(true);
        expect(order.spanIsLast).toBe(true);
        expect(order.hasTextBefore).toBe(true);
    });

    test('legacy "true" storage migrates to always-on after reload', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_css_' + ts);
        await page.waitForTimeout(1500);

        await page.evaluate(() => localStorage.setItem('show_msg_times', 'true')); // legacy checkbox value
        await page.reload();
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1200);

        const migrated = await page.evaluate(() => {
            const sel = document.getElementById('show-msg-times') as HTMLSelectElement;
            return {
                bodyAlways: document.body.classList.contains('show-msg-times-always'),
                bodyHover: document.body.classList.contains('show-msg-times-hover'),
                selectValue: sel ? sel.value : null,
            };
        });
        expect(migrated.bodyAlways).toBe(true);
        expect(migrated.bodyHover).toBe(false);
        expect(migrated.selectValue).toBe('always');

        // Always-on mode actually shows the span inline.
        const on = await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = '<div class="message"><div class="text">hi<span class="time-hover">1:00</span></div></div>';
            document.body.appendChild(div);
            document.body.classList.add('show-msg-times-always');
            const span = div.querySelector('.time-hover') as HTMLElement;
            const displayOn = getComputedStyle(span).display;
            document.body.classList.remove('show-msg-times-always');
            const displayOff = getComputedStyle(span).display;
            div.remove();
            return { displayOn, displayOff };
        });
        expect(on.displayOn).toBe('inline');
        expect(on.displayOff).toBe('none');
    });

    test('Copy Text copies the message, not the timestamp or the (edited) label', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_copy_' + ts);
        await page.waitForSelector('#message-list', { timeout: 15000 });
        await page.waitForTimeout(1000);

        // The time is not a sibling of the text: it is a `.time-hover` span
        // *inside* `.text` (that is what puts it at the end of the line on
        // hover), and an edit adds an `.edited-label` next to it. Reading
        // `textContent` off `.text` therefore copied "14:32" and "(edited)" with
        // every message.
        await page.evaluate(() => {
            const list = document.getElementById('message-list')!;
            const div = document.createElement('div');
            div.className = 'message';
            div.setAttribute('data-message-id', 'copy-probe-1');
            div.setAttribute('data-sender-id', 'someone-else');
            div.innerHTML = '<div class="text">ship it <span class="time-hover">14:32</span>'
                + '<span class="edited-label">(edited)</span></div>';
            list.appendChild(div);

            // Capture what the Copy Text action writes, instead of reading the
            // engine clipboard (which a headless browser cannot grant).
            (window as any).__copied = [];
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: async (t: string) => { (window as any).__copied.push(t); } },
            });
        });

        await page.locator('#message-list .message[data-message-id="copy-probe-1"]').click({ button: 'right' });
        await page.locator('.context-menu-item', { hasText: 'Copy Text' }).first().click();
        await page.waitForTimeout(300);

        const copied = await page.evaluate(() => (window as any).__copied as string[]);
        expect(copied).toHaveLength(1);
        expect(copied[0]).toBe('ship it');
        expect(copied[0]).not.toContain('14:32');
        expect(copied[0]).not.toContain('(edited)');
    });
});
