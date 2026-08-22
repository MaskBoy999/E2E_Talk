import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
}

async function createServerAndChannel(page: Page) {
    await page.waitForFunction(() => document.getElementById('choice-create-server') !== null, { timeout: 10000 });
    await page.dispatchEvent('#choice-create-server', 'click');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
    await page.fill('#new-server-name', 'SchedTest');
    await page.click('#confirm-create-server');
    await page.waitForTimeout(3000);
    await page.waitForSelector('.server-icon', { timeout: 5000 });
    await page.locator('.server-icon').first().click();
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => {
        const cl = document.getElementById('channel-list');
        return cl && cl.innerHTML.length > 10;
    }, { timeout: 10000 });
    const ch = page.locator('.channel-item').first();
    if (await ch.isVisible().catch(() => false)) {
        await ch.click();
        await page.waitForTimeout(1500);
    }
    await page.waitForFunction(() => {
        const el = document.getElementById('message-input');
        return el && !el.disabled;
    }, { timeout: 10000 });
}

function waitForWs(page: Page) {
    return page.waitForFunction(() => {
        const w = (window as any).ws;
        return w && w.readyState === 1;
    }, { timeout: 15000 });
}

async function openScheduleModal(page: Page) {
    await page.click('#attach-btn');
    await page.waitForSelector('#attach-popup', { state: 'visible', timeout: 5000 });
    await page.click('[data-action="schedule"]');
    await page.waitForSelector('#schedule-msg-modal', { state: 'visible', timeout: 5000 });
}

async function scheduleMessage(page: Page, text: string, msFromNow: number) {
    // Set ALL values and click confirm in a single evaluate to avoid timing issues
    await page.evaluate(({ text, ms }) => {
        const ft = new Date(Date.now() + ms);
        const d = ft.getFullYear() + '-' + String(ft.getMonth() + 1).padStart(2, '0') + '-' + String(ft.getDate()).padStart(2, '0');
        const t = String(ft.getHours()).padStart(2, '0') + ':' + String(ft.getMinutes()).padStart(2, '0');
        (document.getElementById('schedule-msg-text') as HTMLInputElement).value = text;
        (document.getElementById('schedule-msg-date') as HTMLInputElement).value = d;
        (document.getElementById('schedule-msg-time') as HTMLInputElement).value = t;
        document.getElementById('schedule-msg-confirm')!.click();
    }, { text, ms: msFromNow });
    await page.waitForTimeout(300);
}

test.describe('Scheduled Messages', () => {
    test('Schedule modal opens with defaults', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        await expect(page.locator('#schedule-msg-modal')).toBeVisible();
        expect(await page.inputValue('#schedule-msg-date')).toBeTruthy();
        expect(await page.inputValue('#schedule-msg-time')).toBeTruthy();
        await page.click('#schedule-msg-cancel');
    });

    test('Cannot schedule empty or past', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        // Empty
        await page.evaluate(() => document.getElementById('schedule-msg-confirm')!.click());
        expect(await page.textContent('#schedule-msg-error')).toContain('empty');
        // Past
        await page.fill('#schedule-msg-text', 'test');
        await page.fill('#schedule-msg-date', '2020-01-01');
        await page.fill('#schedule-msg-time', '00:00');
        await page.evaluate(() => document.getElementById('schedule-msg-confirm')!.click());
        expect(await page.textContent('#schedule-msg-error')).toContain('future');
        await page.click('#schedule-msg-cancel');
    });

    test('Stores message with encryption context', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        await scheduleMessage(page, 'Ctx check', 60000);

        const msg = await page.evaluate(() => {
            const raw = localStorage.getItem('scheduled_messages');
            return raw ? JSON.parse(raw)[0] : null;
        });
        expect(msg).toBeTruthy();
        expect(msg.text).toBe('Ctx check');
        expect(msg.serverId).toBeTruthy();
        expect(msg.channelId).toBeTruthy();
        expect(msg.sendAt).toBeTruthy();

        await page.evaluate(() => localStorage.removeItem('scheduled_messages'));
    });

    test('Cancel removes from list', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        await scheduleMessage(page, 'Cancel me', 3600000);

        // Re-open and cancel
        await openScheduleModal(page);
        const listText = await page.textContent('#schedule-msg-list');
        expect(listText).toContain('Cancel me');

        await page.locator('#schedule-msg-list button').first().click();
        await page.waitForTimeout(300);
        expect(await page.textContent('#schedule-msg-list')).toContain('No scheduled');
        await page.click('#schedule-msg-cancel');
    });

    test('Scheduler fires and sends encrypted message', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        // Schedule for ~65s from now (must be > 1 minute so :00 seconds is still future)
        await scheduleMessage(page, 'Fire test', 65000);

        // Verify stored with encryption context
        const stored = await page.evaluate(() => {
            const raw = localStorage.getItem('scheduled_messages') || '[]';
            return JSON.parse(raw);
        });
        console.log('DEBUG stored:', JSON.stringify(stored));
        expect(stored.length).toBe(1);
        expect(stored[0].serverId).toBeTruthy();
        expect(stored[0].channelId).toBeTruthy();

        // Verify sendAt is in the future
        const sendAt = new Date(stored[0].sendAt).getTime();
        expect(sendAt).toBeGreaterThan(Date.now());

        // Verify server key is available
        const keyAvail = await page.evaluate(() => {
            return Object.keys(localStorage).filter(k => k.startsWith('e2e_server_')).length > 0;
        });
        expect(keyAvail).toBeTruthy();

        // Wait for scheduler to fire (~65s + buffer)
        await page.waitForTimeout(70000);

        // Verify consumed
        expect(await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('scheduled_messages') || '[]');
            return s.length;
        })).toBe(0);

        await page.evaluate(() => localStorage.removeItem('scheduled_messages'));
    });

    test('Persist across reload', async ({ page }) => {
        const ts = unique('sched');
        await register(page, ts);
        await createServerAndChannel(page);
        await waitForWs(page);

        await openScheduleModal(page);
        await scheduleMessage(page, 'Persist', 3600000);

        await page.reload({ waitUntil: 'networkidle' });
        // After reload, page may land on index.html or redirect to login.html
        const url = page.url();
        if (url.includes('login')) {
            // Re-login
            await page.waitForSelector('#show-login', { timeout: 10000 });
            await page.fill('#login-username', ts);
            await page.fill('#login-password', 'testpass1234');
            await page.click('#login-form button[type="submit"]');
            await page.waitForURL('**/index.html', { timeout: 30000 });
        }
        await page.waitForSelector('#current-user', { timeout: 15000 });
        await waitForWs(page);

        // Navigate to the server channel
        await page.waitForSelector('.server-icon', { timeout: 10000 });
        await page.locator('.server-icon').first().click();
        await page.waitForTimeout(2000);
        await page.waitForFunction(() => {
            const cl = document.getElementById('channel-list');
            return cl && cl.innerHTML.length > 10;
        }, { timeout: 10000 });
        const ch = page.locator('.channel-item').first();
        if (await ch.isVisible().catch(() => false)) {
            await ch.click();
            await page.waitForTimeout(1500);
        }

        await openScheduleModal(page);
        expect(await page.textContent('#schedule-msg-list')).toContain('Persist');
        await page.evaluate(() => localStorage.removeItem('scheduled_messages'));
        await page.click('#schedule-msg-cancel');
    });
});
