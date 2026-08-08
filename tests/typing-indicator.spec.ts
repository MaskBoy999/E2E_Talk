import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Typing indicators (ephemeral WS relay)', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    async function waitForWs(page: any, maxRetries = 60) {
        return await page.evaluate((maxRetries) => {
            return new Promise((resolve) => {
                let tries = 0;
                const check = () => {
                    tries++;
                    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                        resolve(true);
                    } else if (tries >= maxRetries) {
                        resolve(false);
                    } else {
                        setTimeout(check, 200);
                    }
                };
                setTimeout(check, 500);
            });
        }, maxRetries);
    }

    async function setupFriends(page: any, page2: any, body1: any, body2: any) {
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
    }

    async function createDm(page: any, page2: any, body1: any, body2: any) {
        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(dm.id).toBeTruthy();
        return { userData, dm };
    }

    async function openDm(page: any) {
        await page.click('#dm-strip-btn').catch(() => {});
        await page.waitForTimeout(800);
        for (let i = 0; i < 40; i++) {
            const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
            if (await conv.count()) {
                await conv.first().click().catch(() => {});
                await page.waitForTimeout(800);
                break;
            }
            await page.waitForTimeout(300);
        }
    }

    test('DM: typing shows indicator on the other side and hides on send', async ({ browser }) => {
        const ts = Date.now();
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const body1 = await registerUser(page, 'typer_a_' + ts);
        const body2 = await registerUser(page2, 'typer_b_' + ts);
        expect(await waitForWs(page)).toBe(true);
        expect(await waitForWs(page2)).toBe(true);
        await setupFriends(page, page2, body1, body2);
        await createDm(page, page2, body1, body2);
        await openDm(page);
        await openDm(page2);
        await page.waitForTimeout(600);

        // A types in the DM composer → B sees "is typing…"
        await page.fill('#message-input', 'hello there');
        await page.waitForTimeout(500);
        const seenByB = await page2.waitForFunction(() => {
            const el = document.getElementById('typing-indicator');
            return el && el.style.display !== 'none' && el.textContent.indexOf('typing') !== -1;
        }, undefined, { timeout: 10000 });
        expect(seenByB).toBeTruthy();
        const indicatorText = await page2.evaluate(() => document.getElementById('typing-indicator')?.textContent || '');
        expect(indicatorText).toContain('typing');

        // A sends the message → indicator clears on B
        await page.press('#message-input', 'Enter');
        await page2.waitForFunction(() => {
            const el = document.getElementById('typing-indicator');
            return el && el.style.display === 'none';
        }, undefined, { timeout: 10000 }).catch(() => {});
        // The message itself arrives on B
        await page2.waitForSelector('.message[data-message-id]', { timeout: 10000 });
        const stillTyping = await page2.evaluate(() => document.getElementById('typing-indicator')?.style.display);
        expect(stillTyping).toBe('none');

        await ctx1.close();
        await ctx2.close();
    });

    test('typing indicator auto-hides after a few seconds of no input', async ({ browser }) => {
        const ts = Date.now();
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const body1 = await registerUser(page, 'typer_c_' + ts);
        const body2 = await registerUser(page2, 'typer_d_' + ts);
        expect(await waitForWs(page)).toBe(true);
        expect(await waitForWs(page2)).toBe(true);
        await setupFriends(page, page2, body1, body2);
        await createDm(page, page2, body1, body2);
        await openDm(page);
        await openDm(page2);
        await page.waitForTimeout(600);

        await page.fill('#message-input', 'hi');
        await page2.waitForFunction(() => {
            const el = document.getElementById('typing-indicator');
            return el && el.style.display !== 'none';
        }, undefined, { timeout: 10000 });
        // Stop typing — indicator should auto-hide within ~5s (4s timer + slack)
        await page2.waitForFunction(() => {
            const el = document.getElementById('typing-indicator');
            return el && el.style.display === 'none';
        }, undefined, { timeout: 8000 });

        await ctx1.close();
        await ctx2.close();
    });
});
