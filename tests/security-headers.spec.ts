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
        // blob: is required by the sandboxed document-preview iframe; the
        // sandbox (no allow-same-origin) is what keeps that frame isolated.
        expect(csp).toContain('frame-src blob:');
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

    // Both script weakenings are gone: the 4 HTML pages with inline <script>
    // blocks (index/admin/pair/box-setup) load external files, the 26 inline
    // `on*=` handlers plus the two generated ones are listeners, and the
    // vendored PDF/ZIP/XLSX/ASR bundles were verified without 'unsafe-eval'
    // before it was dropped. `wasm-unsafe-eval` stays — WebAssembly
    // instantiation needs it and it does not permit JS eval.
    test('CSP blocks inline scripts (no unsafe-inline in script-src)', async ({ page }) => {
        const res = await page.request.get(`${BASE}/api/client-config`);
        const csp = res.headers()['content-security-policy'];
        const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src'));
        expect(scriptSrc).toBeTruthy();
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    test('CSP drops unsafe-eval too (only wasm-unsafe-eval remains)', async ({ page }) => {
        const res = await page.request.get(`${BASE}/api/client-config`);
        const csp = res.headers()['content-security-policy'];
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).toContain("'wasm-unsafe-eval'");
    });

    test('the served pages carry no inline scripts or inline handlers', async ({ request }) => {
        // The policy without 'unsafe-inline' blocks inline script outright;
        // this asserts the prose (/path:line texts, generated buttons) was
        // actually converted, so a future edit cannot silently reintroduce a
        // dead inline handler that the CSP then refuses.
        for (const p of ['/index.html', '/login.html', '/admin.html', '/pair.html', '/box-setup.html', '/box-wipe.html']) {
            const html = await (await request.get(`${BASE}${p}`)).text();
            expect(html, `${p} carries an inline <script> block`)
                .not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
            expect(html, `${p} carries an inline on*= handler`)
                .not.toMatch(/\son[a-z]{2,12}\s*=/i);
        }
    });

    test('an injected inline script and inline handler cannot run', async ({ page }) => {
        // The header assertions above are the contract; this is the browser
        // enforcing it. A dynamic <script> with text (the way an injection
        // lands after the CSP is what has to stop it) and an on* attribute
        // must both be refused, not just look refused on paper.
        await page.goto(`${BASE}/login.html`);
        const ran = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            const s = document.createElement('script');
            s.textContent = 'window.__inlineRan = true;';
            document.body.appendChild(s);
            const img = document.createElement('img');
            img.setAttribute('onerror', 'window.__handlerRan = true;');
            img.src = 'data:,';
            document.body.appendChild(img);
            return new Promise<{ inline: boolean; handler: boolean }>((resolve) => {
                setTimeout(() => resolve({
                    inline: w.__inlineRan === true,
                    handler: w.__handlerRan === true,
                }), 500);
            });
        });
        expect(ran.inline).toBe(false);
        expect(ran.handler).toBe(false);
    });

    test('HSTS is present on 404 responses too', async ({ request }) => {
        const res = await request.get(`${BASE}/nonexistent-page-${Date.now()}.html`);
        const hsts = res.headers()['strict-transport-security'];
        expect(hsts).toBeTruthy();
        expect(hsts).toContain('max-age=31536000');
    });
});
