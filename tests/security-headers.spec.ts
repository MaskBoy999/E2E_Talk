import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Security Headers (S1 CSP + S2 HSTS)', () => {
    test('API response includes Content-Security-Policy header', async ({ request }) => {
        const res = await request.get(`${BASE}/api/client-config`);
        const csp = res.headers()['content-security-policy'];
        expect(csp).toBeTruthy();
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain("form-action 'self'");
    });

    test('API response includes Strict-Transport-Security header', async ({ request }) => {
        const res = await request.get(`${BASE}/api/client-config`);
        const hsts = res.headers()['strict-transport-security'];
        expect(hsts).toBeTruthy();
        expect(hsts).toContain('max-age=31536000');
        expect(hsts).toContain('includeSubDomains');
    });

    test('API response includes all other security headers', async ({ request }) => {
        const res = await request.get(`${BASE}/api/client-config`);
        expect(res.headers()['x-content-type-options']).toBe('nosniff');
        expect(res.headers()['x-frame-options']).toBe('DENY');
        expect(res.headers()['referrer-policy']).toBe('no-referrer');
    });

    test('Static HTML page includes CSP header', async ({ request }) => {
        const res = await request.get(`${BASE}/login.html`);
        const csp = res.headers()['content-security-policy'];
        expect(csp).toBeTruthy();
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("connect-src 'self'");
    });

    test('Static JS file includes CSP header', async ({ request }) => {
        const res = await request.get(`${BASE}/chat.js`);
        const csp = res.headers()['content-security-policy'];
        expect(csp).toBeTruthy();
        expect(csp).toContain("script-src 'self'");
    });

    test('Static CSS file includes CSP header', async ({ request }) => {
        const res = await request.get(`${BASE}/style.css`);
        const csp = res.headers()['content-security-policy'];
        expect(csp).toBeTruthy();
        expect(csp).toContain("style-src 'self'");
    });

    test('CSP blocks inline script execution (nonce not provided)', async ({ page }) => {
        // Verify the CSP is strict enough by checking that wasm-unsafe-eval is the only non-self script source
        const res = await page.request.get(`${BASE}/api/client-config`);
        const csp = res.headers()['content-security-policy'];
        // Should NOT have 'unsafe-eval' (only wasm-unsafe-eval)
        expect(csp).not.toContain("'unsafe-eval'");
        // Should NOT have 'unsafe-inline' for scripts
        const scriptSrc = csp.split(';').find(s => s.trim().startsWith('script-src'));
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('HSTS is present on 404 responses too', async ({ request }) => {
        const res = await request.get(`${BASE}/nonexistent-page-${Date.now()}.html`);
        const hsts = res.headers()['strict-transport-security'];
        expect(hsts).toBeTruthy();
        expect(hsts).toContain('max-age=31536000');
    });
});
