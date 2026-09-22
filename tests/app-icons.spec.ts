import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

// The app has ONE logo. `npm run icon` (tools/box-icon.mjs) rasterises it from
// src-tauri/icons/source/box-icon.png into every surface there is: the desktop
// bundle, the Android launcher mipmaps, the browser tab icon, the PWA/home-screen
// icons, the notification icon and the push badge.
//
// These tests are the WIRING check, and they exist because the artwork was never
// the problem: the references were. Every web icon pointed at a file that did not
// exist (`/favicon.ico`, `/icons/icon-192.png`) or declared an SVG that Chrome and
// Android ignore for installs, and — once the files existed — the static handler
// still served them as `application/octet-stream`, which `X-Content-Type-Options:
// nosniff` makes the browser refuse. The visible result was a generic placeholder
// logo on every surface while the source artwork was perfectly fine.

const WEB_ICONS: Array<[string, string]> = [
    ['/favicon.ico', 'image/x-icon'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
    ['/icons/apple-touch-icon.png', 'image/png'],
    ['/icons/badge-96.png', 'image/png'],
];

test.describe('app icons', () => {
    test('every icon the app references exists and is served with an image content type', async ({ request }) => {
        for (const [path, type] of WEB_ICONS) {
            const res = await request.get(`${BASE}${path}`);
            expect(res.status(), `${path} must exist`).toBe(200);
            // Not octet-stream: with nosniff the browser would download it and
            // then ignore it, which is how the icons silently stayed generic.
            expect(res.headers()['content-type'], `${path} content type`).toContain(type);

            const body = await res.body();
            expect(body.length, `${path} must not be empty`).toBeGreaterThan(100);
            if (type === 'image/png') {
                expect(
                    Array.from(body.subarray(0, 4)),
                    `${path} must really be a PNG`
                ).toEqual([0x89, 0x50, 0x4e, 0x47]);
            } else {
                // .ico: 00 00 01 00
                expect(Array.from(body.subarray(0, 4))).toEqual([0x00, 0x00, 0x01, 0x00]);
            }
        }
    });

    test('the web manifest points at real PNG icons, including a maskable one', async ({ request }) => {
        const res = await request.get(`${BASE}/manifest.json`);
        expect(res.status()).toBe(200);
        const manifest = await res.json();

        expect(Array.isArray(manifest.icons)).toBe(true);
        expect(manifest.icons.length).toBeGreaterThan(0);

        let maskable = 0;
        for (const icon of manifest.icons) {
            expect(icon.type, `${icon.src} must be a raster icon`).toBe('image/png');
            if (icon.purpose === 'maskable') maskable++;

            const iconRes = await request.get(`${BASE}${icon.src}`);
            expect(iconRes.status(), `${icon.src} (from the manifest) must exist`).toBe(200);
            expect(iconRes.headers()['content-type']).toContain('image/png');
        }
        // Android masks the launcher icon, so a maskable variant is not optional.
        expect(maskable, 'the manifest must declare a maskable icon').toBeGreaterThan(0);
    });

    test('the page head and the service worker reference icons that exist', async ({ request }) => {
        const html = await (await request.get(`${BASE}/index.html`)).text();
        expect(html).toContain('rel="icon" href="/favicon.ico"');
        expect(html).toContain('href="/icons/icon-192.png"');
        expect(html).toContain('rel="apple-touch-icon"');

        // The push handler's icon/badge — these are what a notification shows
        // when the app is closed, and both used to 404.
        const sw = await (await request.get(`${BASE}/sw.js`)).text();
        const push = sw.slice(sw.indexOf("self.addEventListener('push'"));
        const refs = Array.from(push.matchAll(/['"](\/icons\/[^'"]+)['"]/g)).map((m) => m[1]);
        expect(refs.length, 'the push handler must name an icon and a badge').toBeGreaterThanOrEqual(2);
        for (const ref of refs) {
            const iconRes = await request.get(`${BASE}${ref}`);
            expect(iconRes.status(), `${ref} (from sw.js) must exist`).toBe(200);
        }

        // The in-app notification icon is the same artwork, not a stale path.
        const chat = await (await request.get(`${BASE}/chat.js`)).text();
        expect(chat).toContain("'/icons/icon-192.png'");
    });
});
