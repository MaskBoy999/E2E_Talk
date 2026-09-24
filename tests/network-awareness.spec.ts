import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/**
 * Network awareness — 6.5, FEATURE_PLAN.md.
 *
 * (a) `sameLanAsBox` is a pure local-facts verdict: private RFC1918 pairs in
 *     the same /24 → true, different networks → false, anything the question
 *     doesn't apply to (public IPs, hostnames) → null. No SSID/BSSID anywhere.
 * (b) Smarter reconnect: while the OS says offline, an unexpected socket close
 *     schedules NO retry loop (no hammering a dead network); the `online`
 *     event reconnects immediately when it returns.
 */
test.describe('network awareness (6.5)', () => {
    test('sameLanAsBox answers only from local IP facts', async ({ page }) => {
        await register(page, unique('lan'));

        const out = await page.evaluate(() => {
            const vm = (window as any).VoiceManager;
            const f = (a: string, b: string) => vm.sameLanAsBox(a, b);
            return {
                samePrivate: f('192.168.1.10', '192.168.1.37'),
                sameTen: f('10.0.0.5', '10.0.0.9'),
                diffSubnet: f('192.168.1.10', '192.168.2.10'),
                crossRange: f('192.168.1.10', '10.0.0.5'),
                publicBox: f('151.101.1.7', '192.168.1.5'),
                publicLocal: f('192.168.1.10', '8.8.8.8'),
                hostname: f('chat.example.com', '192.168.1.5'),
                localhost: f('localhost', '192.168.1.5'),
                garbage: f('not-an-ip', '192.168.1.5'),
                dockerRange: f('172.17.0.1', '172.17.0.9'),
                badOctet: f('192.168.1.999', '192.168.1.5'),
            };
        });

        expect(out.samePrivate).toBe(true);
        expect(out.sameTen).toBe(true);
        expect(out.diffSubnet).toBe(false);
        expect(out.crossRange).toBe(false);
        expect(out.publicBox).toBeNull();
        expect(out.publicLocal).toBeNull();
        expect(out.hostname).toBeNull();
        expect(out.localhost).toBeNull();
        expect(out.garbage).toBeNull();
        expect(out.dockerRange).toBe(true);
        expect(out.badOctet).toBeNull();
    });

    test('offline: a socket drop schedules no retry; `online` reconnects at once', async ({ page }) => {
        await register(page, unique('reconn'));
        // Wait for the initial socket to be live.
        await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN, null, { timeout: 20000 });

        // 1) OS says the network is gone → the close must NOT arm the 1s retry.
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
            (window as any).ws.close();
        });
        await page.waitForTimeout(1800);
        const offlineState = await page.evaluate(() => ({
            timer: (window as any)._wsReconnectTimer,
            readyState: (window as any).ws ? (window as any).ws.readyState : null,
        }));
        expect(offlineState.timer).toBeNull(); // no hammering a dead network
        expect(offlineState.readyState).toBe(WebSocket.CLOSED);

        // 2) Network returns → `online` reconnects immediately (no 1s wait).
        await page.evaluate(() => {
            delete (Object.getPrototypeOf(navigator) ? (navigator as any).onLine : 'onLine');
            Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
            window.dispatchEvent(new Event('online'));
        });
        await page.waitForFunction(() => (window as any).ws && (window as any).ws.readyState !== WebSocket.CLOSED, null, { timeout: 10000 });
        const onlineState = await page.evaluate(() => (window as any).ws.readyState);
        expect(onlineState).not.toBe(WebSocket.CLOSED);
    });

    test('the diagnostics panel shows a Network line (facts only)', async ({ page }) => {
        await register(page, unique('netpanel'));
        const text = await page.evaluate(async () => {
            const w = window as any;
            const list = document.getElementById('voice-diag-list');
            if (!list) return 'NO_PANEL';
            w.VoiceManager.refreshVoiceDiag && w.VoiceManager.refreshVoiceDiag();
            await new Promise((r) => setTimeout(r, 400));
            return list.innerText;
        });
        // Not in a call → the line still renders, honestly saying "unknown".
        expect(text).toContain('Network');
        expect(text).toContain('no ICE candidates yet');
    });
});
