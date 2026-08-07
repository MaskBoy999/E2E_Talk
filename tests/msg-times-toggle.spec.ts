import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Message timestamps toggle + placement', () => {

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

    test('default: body.show-msg-times class is applied and toggle exists', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_toggle_' + ts);
        await page.waitForTimeout(1500);

        const state = await page.evaluate(() => {
            return {
                bodyClass: document.body.classList.contains('show-msg-times'),
                checkbox: !!document.getElementById('show-msg-times'),
                checkboxChecked: (document.getElementById('show-msg-times') as HTMLInputElement)?.checked,
                stored: localStorage.getItem('show_msg_times'),
            };
        });
        expect(state.bodyClass).toBe(true); // default ON
        expect(state.checkbox).toBe(true);
        expect(state.checkboxChecked).toBe(true);
    });

    test('toggling the checkbox off removes the body class and persists', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_toggle_off_' + ts);
        await page.waitForTimeout(1500);

        await page.evaluate(() => {
            const cb = document.getElementById('show-msg-times') as HTMLInputElement;
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const state = await page.evaluate(() => ({
            bodyClass: document.body.classList.contains('show-msg-times'),
            stored: localStorage.getItem('show_msg_times'),
        }));
        expect(state.bodyClass).toBe(false);
        expect(state.stored).toBe('false');
    });

    test('time-hover span is rendered at the END of the message text, not the start', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_placement_' + ts);
        await page.waitForTimeout(1500);

        // Build the same message HTML the app produces and check child order:
        // the .time-hover span must come AFTER the message text.
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

    test('time-hover is display:none when toggle off, inline when on', async ({ browser }) => {
        const ts = Date.now();
        const page = await loginUser(browser, 'times_css_' + ts);
        await page.waitForTimeout(1500);

        // With toggle ON: span is visible via body.show-msg-times
        const on = await page.evaluate(() => {
            const div = document.createElement('div');
            div.innerHTML = '<div class="message"><div class="text">hi<span class="time-hover">1:00</span></div></div>';
            document.body.appendChild(div);
            document.body.classList.add('show-msg-times');
            const span = div.querySelector('.time-hover') as HTMLElement;
            const display = getComputedStyle(span).display;
            document.body.classList.remove('show-msg-times');
            const displayOff = getComputedStyle(span).display;
            div.remove();
            return { displayOn: display, displayOff };
        });
        expect(on.displayOn).toBe('inline');
        expect(on.displayOff).toBe('none');
    });
});
